module.exports = (function () {
  let isAutoReconnect = false
  let WebSocket = require('ws')
  let EventEmitter = require('events').EventEmitter
  let protobuf = require('pomelo-protobuf')

  let WS_CONNECTING = 0;  // ws 已经连接
  let WS_OPEN = 1;        // ws 已经打开
  let WS_CLOSING = 2;     // ws 正在关闭
  let WS_CLOSED = 3;      // ws 已经关闭

  let Events = {
    'ERROR': 'error',                           // 错误
    'IOERROR': 'ioError',                       // io错误
    'RECONNECT': 'reconnect',                   // 尝试重连
    'RECONNECTED': 'reconnected',               // 重连成功
    'HEARTBEAT_TIMEOUT': 'heartbeatTimeout',    // 心跳超时
    'RECONNECT_TIMEOUT': 'reconnectTimeout',    // 重连超时
    'CLOSE': 'close',                           // 断开连接，onKick,服务端关闭，disconnect都会触发
    'ONKICK': 'onKick'                          // 被踢出，业务逻辑中被踢后重连
  }

  let JS_WS_CLIENT_TYPE = 'js-websocket'
  let JS_WS_CLIENT_VERSION = '0.0.1'

  let Protocol = require('pomelo-protocol')
  let Package = Protocol.Package
  let Message = Protocol.Message

  let RES_OK = 200
  let RES_FAIL = 500
  let RES_OLD_CLIENT = 501

  if (typeof Object.create !== 'function') {
    Object.create = function (o) {
      function F () {}
      F.prototype = o
      return new F()
    }
  }

  let pomelo = Object.create(EventEmitter.prototype); // object extend from object

  pomelo.Events = Events
  let socket = null
  let reqId = 0
  let callbacks = {}
  let handlers = {}
  // Map from request id to route
  let routeMap = {}
  let dict = {};    // route string to code
  let abbrs = {};   // code to route string
  let serverProtos = {}
  let clientProtos = {}
  let protoVersion = 0

  let heartbeatInterval = 0
  let heartbeatTimeout = 0
  let nextHeartbeatTimeout = 0
  let gapThreshold = 100;   // heartbeat gap threashold
  let heartbeatId = null
  let heartbeatTimeoutId = null

  let handshakeCallback = null

  let decode = null
  let encode = null

  let handshakeBuffer = {'sys': {type: JS_WS_CLIENT_TYPE,
      version: JS_WS_CLIENT_VERSION},
    'user': {}}

  let initCallback = null

  // add for reconnect
  let ws_url = ''
  let reconnectTimeoutId = 0
  let reconnectIndex = 0

  /**
   * 发现连接断开的处理函数
   */
  let dealOnClose = function () {
    let url = socket.url

    if (!reconnectTimeoutId) {
      reconnectTimeoutId = setTimeout(reconnect, 1000)
    }
  }

  /**
   * 重新连接
   */
  let reconnect = function () {
    pomelo.emit(Events.RECONNECT, reconnectIndex)

    reconnectIndex++
    reconnectTimeoutId = 0

    initWebSocket(ws_url, function () {
      pomelo.emit(Events.RECONNECTED, reconnectIndex)
      reconnectIndex = 0
    })
  }

  // end add for reconnect

  /**
   * 初始化连接的函数
   * @param params{Object}  eg.{host:"localhost",port:"3010"}
   * @param cb{Function}    初始化完成后回调
   */
  pomelo.init = function (params, cb) {

    // 如果已经调用连接，则不重连了
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId)
    }

    let host = params.host
    let port = params.port

    encode = params.encode || defaultEncode
    decode = params.decode || defaultDecode

    console.log('encode: ' + !!params.encode)

    let url = ''
    if(params.useSSL){
      url = 'wss://' + host
    } else {
      url = 'ws://' + host
    }


    if (port) {
      url += ':' + port
    }

    ws_url = url

    handshakeBuffer.user = params.user
    handshakeCallback = params.handshakeCallback
    initWebSocket(url, cb)
  }

  pomelo.close = function() {
    if (socket) {
      socket.close()
    }
  }

  /**
   * 断开连接的函数
   */
  pomelo.disconnect = function () {
    if (socket) {
      if (socket.disconnect) socket.disconnect()
      if (socket.close) socket.close()
      console.log('disconnect')

      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null

      socket = null
    }

    if (heartbeatId) {
      clearTimeout(heartbeatId)
      heartbeatId = null
    }
    if (heartbeatTimeoutId) {
      clearTimeout(heartbeatTimeoutId)
      heartbeatTimeoutId = null
    }
  }

  /**
   * 发送请求，会有结果返回
   * @param route{String} 协议路由
   * @param msg{Object}   消息,如果定义了protobuf，则require字段必须有数据
   * @param cb{Function}  消息处理函数,参数是json数据 cb(json)
   */
  pomelo.request = function (route, msg, cb) {
    if (arguments.length === 2 && typeof msg === 'function') {
      cb = msg
      msg = {}
    } else {
      msg = msg || {}
    }
    route = route || msg.route
    if (!route) {
      return
    }

    reqId++
    sendMessage(reqId, route, msg)

    callbacks[reqId] = cb
    routeMap[reqId] = route

    return reqId
  }

  /**
   * 给服务端发送通知
   * @param route{String} 协议路由
   * @param msg{Object}   消息,如果定义了protobuf，则require字段必须有数据
   */
  pomelo.notify = function (route, msg) {
    msg = msg || {}
    sendMessage(0, route, msg)
  }


  let defaultDecode = pomelo.decode = function (data) {
    // probuff decode
    let msg = Message.decode(data)

    if (msg.id > 0) {
      msg.route = routeMap[msg.id]
      delete routeMap[msg.id]
      if (!msg.route) {
        return
      }
    }

    msg.body = deCompose(msg)
    return msg
  }


  let defaultEncode = pomelo.encode = function (reqId, route, msg) {
    let type = reqId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY

    // compress message by protobuf
    if (clientProtos && clientProtos[route]) {
      msg = protobuf.encode(route, msg)
    } else {
      msg = Protocol.strencode(JSON.stringify(msg))
    }

    let compressRoute = 0
    if (dict && dict[route]) {
      route = dict[route]
      compressRoute = 1
    }

    return Message.encode(reqId, type, compressRoute, route, msg)
  }

  let clearSocket = function (socket) {
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
  }

  let initWebSocket = function (url, cb) {
    initCallback = cb

    console.log('connect to ' + url)
    // Add protobuf version
    // if(localStorage && localStorage.getItem('protos') && protoVersion === 0){
    //   let protos = JSON.parse(localStorage.getItem('protos'))
    //
    //   protoVersion = protos.version || 0
    //   serverProtos = protos.server || {}
    //   clientProtos = protos.client || {}
    //
    //   if(protobuf) protobuf.init({encoderProtos: clientProtos, decoderProtos: serverProtos})
    // }
    // Set protoversion
    handshakeBuffer.sys.protoVersion = protoVersion

    let onopen = function (event) {
      let obj = Package.encode(Package.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(handshakeBuffer)))
      send(obj)
    }


    let onmessage = function (event) {
      processPackage(Package.decode(event.data), cb)
      // new package arrived, update the heartbeat timeout
      if (heartbeatTimeout) {
        nextHeartbeatTimeout = Date.now() + heartbeatTimeout
      }
    }


    let onerror = function (event) {
      pomelo.emit(Events.IOERROR, event)
      // console.error('socket error: ', event)
    }

    let onclose = function (event) {
      pomelo.emit(Events.CLOSE, event)
      if (isAutoReconnect) {
        dealOnClose()
      }
    }

    if (socket) {
      clearSocket(socket)
    }

    socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    socket.onopen = onopen
    socket.onmessage = onmessage
    socket.onerror = onerror
    socket.onclose = onclose
  }


  let sendMessage = function (reqId, route, msg) {
    if (encode) {
      msg = encode(reqId, route, msg)
    }

    let packet = Package.encode(Package.TYPE_DATA, msg)
    send(packet)
  }

  let send = function (packet) {
    if (socket === null) {
      console.log('socket.send 时为空')
    } else if (socket.readyState !== WS_OPEN) {
      console.log('socket.send 时 readyState 为' + socket.readyState)
    } else {
      socket.send(packet)
    }
  }

  let handler = {}

  let heartbeat = function (data) {
    if (!heartbeatInterval) {
      // no heartbeat
      return
    }

    let obj = Package.encode(Package.TYPE_HEARTBEAT)
    if (heartbeatTimeoutId) {
      clearTimeout(heartbeatTimeoutId)
      heartbeatTimeoutId = null
    }

    if (heartbeatId) {
      // already in a heartbeat interval
      return
    }

    heartbeatId = setTimeout(function () {
      heartbeatId = null
      send(obj)

      nextHeartbeatTimeout = Date.now() + heartbeatTimeout
      heartbeatTimeoutId = setTimeout(heartbeatTimeoutCb, heartbeatTimeout)
    }, heartbeatInterval)
  }

  let heartbeatTimeoutCb = function () {
    let gap = nextHeartbeatTimeout - Date.now()
    if (gap > gapThreshold) {
      heartbeatTimeoutId = setTimeout(heartbeatTimeoutCb, gap)
    } else {
      pomelo.emit(Events.HEARTBEAT_TIMEOUT)
      pomelo.disconnect()
    }
  }

  let handshake = function (data) {
    data = JSON.parse(Protocol.strdecode(data))
    if (data.code === RES_OLD_CLIENT) {
      pomelo.emit(Events.ERROR, 'client version not fullfill')
      return
    }

    if (data.code !== RES_OK) {
      pomelo.emit(Events.ERROR, 'handshake fail')
      return
    }

    handshakeInit(data)

    let obj = Package.encode(Package.TYPE_HANDSHAKE_ACK)
    send(obj)
    if (initCallback) {
      initCallback(socket)
      initCallback = null
    }
  }

  let onData = function (data) {
    let msg = data
    if (decode) {
      msg = decode(msg)
    }
    processMessage(pomelo, msg)
  }

  let onKick = function (data) {
    data = Protocol.strdecode(data)

    try {
      data = JSON.parse(data)
    } catch (e) {
      console.log(e.message)
    }
    pomelo.emit(Events.ONKICK, data)
  }

  handlers[Package.TYPE_HANDSHAKE] = handshake
  handlers[Package.TYPE_HEARTBEAT] = heartbeat
  handlers[Package.TYPE_DATA] = onData
  handlers[Package.TYPE_KICK] = onKick

  let processPackage = function (msg) {
    handlers[msg.type](msg.body)
  }

  let processMessage = function (pomelo, msg) {
    if (!msg.id) {
      pomelo.emit('onPushMessage', msg)
      // server push message
      pomelo.emit(msg.route, msg.body)
      return
    }

    // if have a id then find the callback function with the request
    let cb = callbacks[msg.id]

    delete callbacks[msg.id]
    if (typeof cb !== 'function') {
      return
    }

    cb(msg.body, msg.id)
    return
  }

  let processMessageBatch = function (pomelo, msgs) {
    for (let i = 0, l = msgs.length; i < l; i++) {
      processMessage(pomelo, msgs[i])
    }
  }

  let deCompose = function (msg) {
    let route = msg.route

    // Decompose route from dict
    if (msg.compressRoute) {
      if (!abbrs[route]) {
        return {}
      }

      route = msg.route = abbrs[route]
    }
    if (serverProtos && serverProtos[route]) {
      console.log('use protobuf')
      return protobuf.decode(route, msg.body)
    } else {
      return JSON.parse(Protocol.strdecode(msg.body))
    }

    return msg
  }

  let handshakeInit = function (data) {
    if (data.sys && data.sys.heartbeat) {
      heartbeatInterval = data.sys.heartbeat * 1000;   // heartbeat interval
      heartbeatTimeout = heartbeatInterval * 2;        // max heartbeat timeout
    } else {
      heartbeatInterval = 0
      heartbeatTimeout = 0
    }

    initData(data)

    if (typeof handshakeCallback === 'function') {
      handshakeCallback(data.user)
    }
  }

  // Initilize data used in pomelo client
  let initData = function (data) {
    if (!data || !data.sys) {
      return
    }
    dict = data.sys.dict
    let protos = data.sys.protos

    // Init compress dict
    if (dict) {
      dict = dict
      abbrs = {}

      for (let route in dict) {
        abbrs[dict[route]] = route
      }
    }

    // Init protobuf protos
    if (protos) {
      protoVersion = protos.version || 0
      serverProtos = protos.server || {}
      clientProtos = protos.client || {}
      if (protobuf) {
        protobuf.init({encoderProtos: protos.client, decoderProtos: protos.server})
      }

      // Save protobuf protos to localStorage
      if (typeof(localStorage) !== 'undefined') {
        localStorage.setItem('protos', JSON.stringify(protos))
      }
    }
  }

  return pomelo
})

