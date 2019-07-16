import path from 'path'
import fs from 'fs'
import ts from 'typescript'
import grpc, { KeyCertPair, ServerCredentials } from 'grpc'

import { Readable, Writable } from 'stream'
import { EventIterator } from 'event-iterator'
import * as protobuf from 'protobufjs'

import { getProtoObject } from './parser'
import { ApiDefinition, wrapFunc, md5, hookFunc, asyncCache } from './utils'

const QUERY_PROTO = require(path.join(__dirname, '..', 'proto.json')),
    QUERY_SERVICE = '_query_proto'

export function loadTsConfig(file: string) {
    const compilerOptionsJson = fs.readFileSync(file, 'utf8'),
        { config, error } = ts.parseConfigFileTextToJson('tsconfig.json', compilerOptionsJson)
    if (error) {
        throw Error(`load config from '${file}' failed`)
    }
    const basePath: string = process.cwd(),
        settings = ts.convertCompilerOptionsFromJson(config.compilerOptions, basePath)
    if (settings.errors.length) {
        for (const error of settings.errors) {
            console.error(error)
        }
        throw Error(`parse config in '${file}' failed`)
    }
    return settings.options
}

function makeClient(proto: any, srvName: string, host: string) {
    const root = (protobuf as any).Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        Client = desc[srvName] as typeof grpc.Client
    return new Client(host, grpc.credentials.createInsecure())
}

function makeAsyncIterator(stream: Readable) {
    let callback: (data: any) => any
    return new EventIterator(
        (push, pop, fail) => stream
            .on('data', callback = data => push(data.result))
            .on('end', pop)
            .on('error', fail),
        (_, pop, fail) => stream
            .removeListener('data', callback)
            .removeListener('end', pop)
            .removeListener('error', fail),
    )
}

async function startAsyncIterator(stream: Writable, iter: AsyncIterableIterator<any>) {
    for await (const result of iter) {
        stream.write({ result })
    }
    stream.end()
}

const clientCache = { } as { [key: string]: any }
export function callService(entry: string, host: string, args: any[], proto: any, cache = clientCache) {
    const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '_'),
        funcName = path.basename(entry),
        cacheKey = `${srvName}/$/${host}`,
        client = cache[cacheKey] || (cache[cacheKey] = makeClient(proto, srvName, host)),
        { requestType, requestStream, responseStream } = proto.nested[srvName].methods[funcName],
        fields = proto.nested[requestType].fields,
        request = Object.keys(fields).reduce((all, key, idx) => ({ ...all, [key]: args[idx] }), { })
    if (requestStream && responseStream) {
        const stream = client[funcName]() as grpc.ClientDuplexStream<any, any>
        startAsyncIterator(stream, args[0])
        return makeAsyncIterator(stream)
    } else if (requestStream) {
        return new Promise((resolve, reject) => {
            const callback = (err: Error, ret: any) => err ? reject(err) : resolve(ret.result),
                stream = client[funcName](callback) as grpc.ClientWritableStream<any>
            startAsyncIterator(stream, args[0])
        })
    } else if (responseStream) {
        const stream = client[funcName](request) as grpc.ClientReadableStream<any>
        return makeAsyncIterator(stream)
    } else {
        return new Promise((resolve, reject) => {
            const callback = (err: Error, ret: any) => err ? reject(err) : resolve(ret.result)
            client[funcName](request, callback)
        })
    }
}

export function makeService(entry: string,
        func: (...args: any[]) => Promise<any> | AsyncIterableIterator<any>, proto: any) {
    const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '_'),
        funcName = path.basename(entry),
        root = (protobuf as any).Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        service = (desc[srvName] as any).service,
        { requestType, requestStream, responseStream } = proto.nested[srvName].methods[funcName],
        fields = proto.nested[requestType].fields,
        argKeys = Object.keys(fields).sort((a, b) => fields[a].id - fields[b].id),
        makeArgs = (request: any) => argKeys.map(key => request[key])
    let fn: Function
    if (requestStream && responseStream) {
        fn = (stream: grpc.ServerDuplexStream<any, any>) => {
            const arg = makeAsyncIterator(stream),
                iter = func(arg) as AsyncIterableIterator<any>
            startAsyncIterator(stream, iter)
        }
    } else if (requestStream) {
        fn = (stream: grpc.ServerReadableStream<any>, callback: grpc.sendUnaryData<any>) => {
            const arg = makeAsyncIterator(stream),
                promise = func(arg) as Promise<any>
            promise
                .then(result => callback(null, { result }))
                .catch(error => callback(error, null))
        }
    } else if (responseStream) {
        fn = (stream: grpc.ServerWriteableStream<any>) => {
            const iter = func(...makeArgs(stream.request)) as AsyncIterableIterator<any>
            startAsyncIterator(stream, iter)
        }
    } else {
        fn = (call: grpc.ServerUnaryCall<any>, callback: grpc.sendUnaryData<any>) => {
            const promise = func(...makeArgs(call.request)) as Promise<any>
            promise
                .then(result => callback(null, { result }))
                .catch(error => callback(error, null))
        }
    }
    return { proto, service, impl: { [funcName]: fn } }
}

export interface GrpcOptions {
    rootCerts: Buffer | null,
    keyCertPairs?: KeyCertPair[],
    checkClientCertificate?: boolean,
}

export class GrpcServer {
    constructor(private readonly server = new grpc.Server()) {
        const proto = async (entry: string) => JSON.stringify(this.methods[entry].proto),
            { service, impl } = makeService(QUERY_SERVICE, proto, QUERY_PROTO)
        server.addService(service, impl)
    }

    start(addr: string, opts = { } as GrpcOptions) {
        const { rootCerts, keyCertPairs, checkClientCertificate } = opts,
            credentials = keyCertPairs ?
                ServerCredentials.createSsl(rootCerts, keyCertPairs, checkClientCertificate) :
                ServerCredentials.createInsecure()
        this.server.bind(addr, credentials)
        this.server.start()
    }
    
    readonly methods = { } as { [entry: string]: { func: Function, proto: Object, hash: string } }
    register<T extends ApiDefinition>(api: T | string, config?: ts.CompilerOptions) {
        const opts = config || loadTsConfig(path.join(__dirname, '..', 'tsconfig.json')),
            decl = typeof api === 'string' ? api : `${api.__filename}`,
            mod  = typeof api === 'string' ? require(api).default : api,
            types = getProtoObject(decl, mod, opts)
        return wrapFunc(mod, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/'),
                [{ receiver, target }] = stack,
                func = target.bind(receiver),
                { proto, service, impl } = makeService(entry, func, types),
                hash = md5(JSON.stringify(proto))
            this.methods[entry] = { func, proto, hash }
            this.server.addService(service, impl)
            return func
        })
    }

    async destroy(waiting = 30) {
        setTimeout(() => this.server.forceShutdown(), waiting * 1000)
        await new Promise(resolve => this.server.tryShutdown(resolve))
    }
}

export class GrpcClient {
    constructor(private host = 'localhost:3456') {
    }

    private proto = asyncCache(async (entry: string) => {
        const json = await callService(QUERY_SERVICE, this.host, [entry], QUERY_PROTO, this.clients)
        return JSON.parse(`${json}`)
    })
    async select(entry: string) {
        const { host } = this,
            proto = await this.proto(entry)
        return { host, proto }
    }

    private clients = { } as { [key: string]: grpc.Client }
    private call(entry: string, args: any[]) {
        let proxy: AsyncIterableIterator<any>
        const cache = this.clients
        // for async functions
        const then = async (resolve: Function, reject: Function) => {
            try {
                const { host, proto } = await this.select(entry),
                    ret = callService(entry, host, args, proto, cache)
                resolve(ret)
            } catch (err) {
                reject(err)
            }
        }
        // for async iterators
        const next = async () => {
            if (!proxy) {
                const { host, proto } = await this.select(entry),
                    ret = callService(entry, host, args, proto, cache) as any
                proxy = ret[Symbol.asyncIterator]()
            }
            return await proxy.next()
        }
        return { then, [Symbol.asyncIterator]: () => ({ next }) }
    }

    query<T extends ApiDefinition>(def = { } as T) {
        return hookFunc(def, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return (...args: any[]) => this.call(entry, args)
        })
    }

    destroy() {
        for (const client of Object.values(this.clients)) {
            client.close()
        }
        this.clients = { }
    }
}
