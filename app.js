var http = require('http'),
  url = require('url'),
  express = require('express'),
  app = express(),
  redis = require('redis'),
  RedisStore = require('connect-redis')(express),
  request = require('request'),
  S = require('string'),
  redisUrl = url.parse(process.env.REDISTOGO_URL || 'redis://localhost:6379'),
  emoji = require('emoji-images'),
  _ = require('underscore')

var port = process.env.PORT || 5000
var sessionStore = new RedisStore({port: redisUrl.port, host: redisUrl.hostname, pass: redisUrl.password})
var cookieParser = express.cookieParser('secert')

redisUrl.password = (function () {
  if (redisUrl.auth) {
    return redisUrl.auth.split(':')[1]
  } else {
    return null
  }
})()

// Configure Express
app.configure(function () {
  app.use(express.bodyParser())
  app.use(express.logger())
  app.use(express.directory('public'))
  app.use(express.static('public'))
  app.use(cookieParser)
  app.use(express.session({ store: sessionStore, secret: 'keyboard' }))
})

// Create server
var server = http.createServer(app).listen(port)

// Create Redis client
var client = redis.createClient(redisUrl.port, redisUrl.hostname)
client.auth(redisUrl.password, function (err, reply) {
  if (err) { console.log('Error connecting to Redis') }
})

// On server start, erase all users and quickly add Shep back.
client.keys('users:*', function (err, reply) {
  if (err) { return }
  _.forEach(reply, function (key) {
    client.del(key)
    client.sadd(key, 'shep')
  })
})

var preprocessMessage = function (m) {
  return m
    .replace(/(^|\s)(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/, "<a target='_blank' href='$2'>$2</a>")
    .replace(/\*([^\*]*)\*/g, '<strong>$1</strong>')
    .replace(/\b_([^_]*)_\b/gi, '<em>$1</em>')
    .replace(/~([^~]*)~/gi, "<span class='comic'>$1</span>")
    .replace(/(\W|^)\-([^\-]*)\-(\W|$)/gi, '$1<del>$2</del>$3')
}

var updateUserList = function (io, roomname) {
  client.smembers('users:' + roomname, function (err, reply) {
    if (err) { return }
    console.log(reply)
    io.sockets.in(roomname).emit('userlist', reply)
  })
}

var io = require('socket.io').listen(server)

io.sockets.on('connection', function (socket) {
  socket.on('join', function (msg) {
    socket.set('nickname', msg.nickname)
    socket.set('rooms', msg.rooms)
    socket.currentRoom = msg.currentRoom
    socket.join(msg.currentRoom)

    socket.get('rooms', function (err, rooms) {
      if (err) { return }
      _.forEach(rooms, function (room) {
        socket.join(room)
        client.sismember('users:' + room, msg.nickname, function (err, reply) {
          if (reply !== 1) {
            client.sadd('users:' + room, msg.nickname, function (err, res) {
              updateUserList(io, room)
            })
          } else {
            updateUserList(io, room)
          }
        })
      })
    })
  })

  socket.on('changeChannel', function (channelName) {
    socket.get('nickname', function (err, nickname) {
      console.log('[ROOM CHANGE] => ' + nickname + ' : ' + channelName)
    })
    // socket.leave(socket.currentRoom)
    // socket.join(channelName)
    socket.currentRoom = channelName
  })

  socket.on('newmessage', function (data) {
    var emojified = emoji(S(data.content).escapeHTML().s, 'http://shep.info/emojis', 18)

    var msg = {
      content: preprocessMessage(emojified),
      channel: data.channel,
      nickname: data.nickname,
      timestamp: Date.now()
    }

    client.rpush('chats:' + data.channel, JSON.stringify(msg), function (err, res) {
      console.log('Redis', err, res)
    })

    // Forward the message to Shep
    request.post(process.env.HUBOT_DOMAIN + '/receive/' + msg.channel, {
      'form': {
        from: msg.nickname,
        message: data.content
    }}, function (err, res, body) {
      if (err) {
        console.log('ERROR TALKING TO SHEP')
      // io.sockets.in(socket.currentRoom).emit('message', {
      //   timestamp: Date.now(),
      //   nickname: 'SYSTEM',
      //   channel: data.channel,
      //   content: 'There was an error talking to Shep.'
      // })
      }
    })

    io.sockets.in(socket.currentRoom).emit('message', msg)
  })

  socket.on('disconnect', function (data) {
    // get the nickname of the user who disconnected.
    socket.get('nickname', function (err, nickname) {
      console.log('[[ DISCONNECT ]] => ' + nickname)
      // leave the rooms our user is in.
      socket.get('rooms', function (err, rooms) {
        _.forEach(rooms, function (room) {
          socket.leave(room)
          client.srem('users:' + room, nickname, function (err, reply) {
            console.log('[[ REDIS ]] => remove ' + nickname + ' from ' + room)
            // return if the nickname was not in the room
            if (reply === 0) { return; }
            // get list of remaining users in this room.
            client.smembers('users:' + room, function (err, reply) {
              // broadcast the updated userlist to the room
              io.sockets.in(room).emit('userlist', reply)
            })
          })
        })
      })
    })
  })
  // end socket.on('disconnect')

})
// end io.sockets.on('connection')

app.post('/responses/:channel', function (req, res) {
  console.log('[[ FROM SHEP ]] ', req.params['channel'], req.params, req.body)
  var m = {
    'channel': req.params.channel,
    'content': req.body.message.replace(/(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/, "<a target='_blank' href='$1'>$1</a>"),
    'nickname': 'shep',
    'timestamp': Date.now()
  }

  client.sadd('logs:' + req.params.channel, JSON.stringify(m), function (err, res) {
    if (err) return
  })

  io.sockets.in(req.params.channel).emit('message', m)
  res.end('hi')
})
