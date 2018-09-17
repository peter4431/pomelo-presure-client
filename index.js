/**
 * Created by wyang on 2018/5/7.
 */

const START = 'start'  // 开始(action,reqId)
const END = 'end'      // 结束(action,reqId)
const clientFunc = require('./lib/client')

module.exports = class Presure {
  constructor (offset) {
    this.client = clientFunc()
    this.client.on('onPushMessage', (msg) => {
      let route = msg.route
      let body = msg.body

      console.log(`id:${this.offset} onPushMessage: ${route} data: ${JSON.stringify(body)}`)
    })

    if (offset === undefined) {
      offset = this.getOffset()
    }

    this.offset = offset
  }

  getOffset () {
    if (typeof actor !== 'undefined') {
      return actor.id
    } else {
      return parseInt(process.argv[2]) || 0
    }
  }

  monitor (type, name, reqId) {
    if (typeof actor !== 'undefined') {
      actor.emit(type, name, reqId)
    }
  }

  request (route, data) {
    let client = this.client
    return new Promise(function (resolve, reject) {
      console.log(`id:${this.offset} ${route} req: ${JSON.stringify(data)}`)
      let reqId = client.request(route, data, function (res, reqId) {
        console.log(`id:${this.offset} route res: ${JSON.stringify(res)}`)
        this.monitor(END, route, reqId)
        resolve(res)
      }.bind(this))

      this.monitor(START, route, reqId)
    }.bind(this))
  }

  init (hostObj) {
    return new Promise(function (resolve, reject) {
      this.client.init(hostObj, function () {
        resolve()
      })
    }.bind(this))
  }

  delay (numSeconds) {
    return new Promise(function (resolve, reject) {
      setTimeout(() => {
        return resolve()
      }, numSeconds * 1000)
    })
  }

  close () {
    this.client.close()
  }

  on (event, func) {
    this.client.on(event, func)
  }
}
