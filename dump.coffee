_ = require('underscore')
url = require('url')
redis = require('redis')
redisUrl = url.parse(process.env.REDISTOGO_URL || 'redis://localhost:6379')

fs = require('fs')

redisUrl.password = (->
  if (redisUrl.auth)
    return redisUrl.auth.split(':')[1]
  else
    return null
)()

client = redis.createClient(redisUrl.port, redisUrl.hostname);
client.auth redisUrl.password, (err, reply) ->
  if (err) then throw err

client.keys 'logs:*', (err, reply) ->
  if (err) then throw err
  _.forEach reply, (key) ->
    console.log reply

client.smembers('logs:itp', (err, reply) ->
  if (err) then return
  console.log reply.length
  fs.writeFile('dump.json', reply, (err) ->
    if (err) then throw err

    console.log "done"
  )
)