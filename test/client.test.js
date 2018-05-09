/**
 * Created by wyang on 2018/5/8.
 */

const vm = require('vm')
const script = `
let client = new (require('../index.js'))()

client.init({host:'127.0.0.1',port:'3001'}).then(function(res){
  console.log('连接成功')
  client.request('connector.loginHandler.login', {})
}, function(err){
  console.log('连接失败')
})
`

for (let i=0;i<2;i++) {
  let initSandbox = {
    actor: {offset: i},
    console: console,
    require: require,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    global: global,
    process: process
  }

  let context = vm.createContext(initSandbox)
  vm.runInContext(script, context)
}
