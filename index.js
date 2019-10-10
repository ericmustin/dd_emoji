require('dotenv').config();

var express = require('express');
var partials = require('express-partials');
var bodyParser = require('body-parser');
const axios = require('axios');
const emoji = require('node-emoji');
const chart = require("text-chart");
const {promisify} = require('util');
var Sentiment = require('sentiment');
var dogapi = require('dogapi')
var sentiment = new Sentiment();

const barChart = new chart.BarChart().setProperties({
    width: 200, // Limit chart's max width
});

const DD_ENV = process.env.DD_ENV

var redisClient = require('redis').createClient;
var client = redisClient(process.env.REDIS_PORT, process.env.REDIS_HOST,{password: process.env.REDIS_PW});

var config = { dd_options: { api_key: process.env.API_KEY, app_key: process.env.APP_KEY}};
dogapi.initialize(config.dd_options)

const getAsync = promisify(client.get).bind(client);
const setAsync = promisify(client.set).bind(client);
const sendMetric = promisify(dogapi.metric.send)

const API_KEY = process.env.API_KEY
const APP_KEY = process.env.APP_KEY
const SLACK_TOKEN = process.env.SLACK_TOKEN
const COMPANY_EMAIL_DOMAIN = process.env.COMPANY_EMAIL_DOMAIN

var app = express();
app.use(partials());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded( { extended: true }));

var exphbs  = require('express-handlebars');
var hbs =  require('handlebars')

var helpers = {
  check_if_https: function(value) { 
    
    let htmlstring = ''
    if(value[0].indexOf("https") >= 0) {
      htmlstring = `<tr><td><img width=21 height=21 alt="emoji" src=${value[0]}></td><td>|${value[1]}</td></tr>`
    } else {
      htmlstring = `<tr><td>${value[0]}</td><td>|${value[1]}</td></tr>`
    }
    
    return new hbs.SafeString(htmlstring);
  }
}

app.engine('handlebars', exphbs({helpers: helpers}));
app.set('view engine', 'handlebars');

const SLACK_USER_LIST_URL = 'https://slack.com/api/users.list'
const SLACK_EMOJI_LIST_URL = 'https://slack.com/api/emoji.list'

let init = async function(req,res) {
  
  let paginationFlag = true;
  let nextCursor = null;
  let emailRegex = new RegExp(`.*@${COMPANY_EMAIL_DOMAIN}`);

  let params = {'token': SLACK_TOKEN, 'limit': 200};
  let headers = {'Content-type': 'application/x-www-form-urlencoded'};
  let user_emojis = undefined
  let custom_emojis = undefined
  let emoji_scores = undefined

  try {
    user_emojis = JSON.parse(await getAsync('user_emojis'));
    custom_emojis = JSON.parse(await getAsync('custom_emojis'));
    emoji_scores = await getAsync('emoji_scores') || {};
    
    if(!user_emojis && !custom_emojis) {
      console.log("cache miss");
    }
  } catch(redisError) {
    console.log('redisError: ', redisError)
  }

  if(user_emojis) {
    console.log('cache hit')
  } else {
    user_emojis = []
    if(DD_ENV !== 'dev') {
      do {
          try { 
            if(nextCursor) {
              params['cursor'] = nextCursor
            }

            let response = await axios.get(SLACK_USER_LIST_URL, {params: params, headers: headers})
            response = response.data

            user_emojis = user_emojis.concat( response['members'].reduce( (filtered, member)=> {
                  let validMember = !member['is_bot'] && !member['deleted'] &&
                  !member['is_restricted'] && !member['is_ultra_restricted'] &&
                  member['profile'] && typeof member['profile']["email"] == "string" && member['profile']["email"].match(emailRegex);

                  if(validMember) {
                    filtered.push(member['profile']['status_emoji'])
                  }

                  return filtered
            }, []));

            if(response['response_metadata'] && response['response_metadata']['next_cursor']) {
              nextCursor = response['response_metadata']['next_cursor'];
            } else {
              paginationFlag = false;
            }
          } catch(error) {
            console.error('exception: ', error)
            break;
          }
      } while (paginationFlag);
    } else {
      user_emojis = require("./user_emoji_list.js")
      console.log('dev user length is: ', user_emojis.length);
    }
    const updated = await setAsync('user_emojis', JSON.stringify(user_emojis), 'EX', 60)
  }
  
  if(custom_emojis) {
    console.log('got emoji list')
  } else {
    let emoji_response = undefined;

    if(DD_ENV !== 'dev') {
      params = {'token': SLACK_TOKEN};
      emoji_response = await axios.get(SLACK_EMOJI_LIST_URL, {params: params, headers: headers})
      emoji_response = emoji_response.data
    } else {
      emoji_response = require("./emoji_list.json")
      console.log(typeof emoji_response)
    }

    if (emoji_response.ok === true) {
      custom_emojis = emoji_response.emoji
      const updated_emojis = await setAsync('custom_emojis', JSON.stringify(custom_emojis), 'EX', 60);
    }
  }

  if(req.method !== "GET") {
    user_emojis = user_emojis.reduce( (total, user) => {
      if(user.length > 0) {
        if(total[user] === undefined) {
          total[user] = 1
        } else{
          total[user] += 1  
        }
      }
      return total
    }, {})
  } else {
    if(req.query.sendMetrics === 'yes') {
      let temp_user_emojis = user_emojis.reduce( (total, user) => {
        if(user.length > 0) {
          if(total[user] === undefined) {
            total[user] = 1
          } else{
            total[user] += 1  
          }
        }
        return total
      }, {})

      Object.keys(temp_user_emojis).forEach( async function(emoji_name) {
        let temp_response = await sendMetric("emoji.active", temp_user_emojis[emoji_name], {tags: "emoji_name:"+emoji_name}) 
      });
    }

    user_emojis = user_emojis.reduce( (total, user) => {
      if(user.length > 0) {
        var tokenized_emoji = {"original": undefined, "tokenized": undefined, "score": undefined, "reference_value": undefined}

        if(emoji.emojify(user) === user) {
          user = user.replace(/:/g, '');

          if( custom_emojis[user] !== undefined) {
            tokenized_emoji.original = user
            tokenized_emoji.tokenized = user.replace(/(_|-)/g, ' ')

            if( custom_emojis[user].indexOf("alias:") >= 0 ) {
              let aliasEmoji = custom_emojis[user].slice("alias:".length + custom_emojis[user].indexOf('alias:'))

              if(custom_emojis[aliasEmoji].indexOf("https") >= 0) {
                tokenized_emoji.reference_value = custom_emojis[aliasEmoji]
                if(total[custom_emojis[aliasEmoji]] === undefined) {
                  total[custom_emojis[aliasEmoji]] = 1
                } else{
                  total[custom_emojis[aliasEmoji]] += 1 
                }
              } else if(emoji.emojify(aliasEmoji) !== aliasEmoji) {
                let emojified = emoji.emojify(aliasEmoji)
                
                tokenized_emoji.reference_value = emojified
                if(total[emojified] === undefined) {
                  total[emojified] = 1
                } else{
                  total[emojified] += 1 
                }
              }
            } else {
              if(custom_emojis[user].indexOf("https") >= 0) {

                tokenized_emoji.reference_value = custom_emojis[user]
                if(total[custom_emojis[user]] === undefined) {
                  total[custom_emojis[user]] = 1
                } else{
                  total[custom_emojis[user]] += 1 
                }
              }
            }
          } 
        } else {
          let tempDetail = emoji.emojify(user)
          tokenized_emoji.original = user
          tokenized_emoji.tokenized = tempDetail
          tokenized_emoji.reference_value = tempDetail

          if(total[tempDetail] === undefined) {
            total[tempDetail] = 1
          } else {
            total[tempDetail] += 1  
          }
        }
        if(emoji_scores[tokenized_emoji.reference_value] === undefined) {
          tokenized_emoji.score = sentiment.analyze(tokenized_emoji.tokenized)
          emoji_scores[tokenized_emoji.reference_value] = tokenized_emoji
        }
      }

      return total
    }, {})
  }

  let sortedUserEmojis = Object.keys(user_emojis).sort(function(a,b){return user_emojis[b]-user_emojis[a]}).map(key => [key,user_emojis[key]])
  var totalCount = sortedUserEmojis.reduce(function(total,next) { total += next[1]; return total}, 0)
  var totalsArray = []

  sortedUserEmojis.forEach( function(x) {
    if(emoji_scores[x[0]] !== undefined) {
      if (emoji_scores[x[0]].score && x[1] > 0) {
        var score = emoji_scores[x[0]].score.comparative
        var tempArray = Array(x[1]).fill(emoji_scores[x[0]].score.comparative)
        totalsArray = totalsArray.concat(tempArray)
      }
    }
  })

  if(req.query.sendMetrics === 'yes') { 
    var totalsScore = ( totalsArray.reduce((a, b) => a + b, 0) / totalsArray.length)
    let temp_response = await sendMetric("emoji.active_sentiment", totalsScore, {tags: "env:"+DD_ENV})
  }
  barChart.setData(sortedUserEmojis);

  if(req.method === "GET") {
    // TODO: https://www.npmjs.com/package/express-handlebars
    let split = {"split_values": barChart.render().split("\n").map(function(x){return x.trim().split("|")})}

    if(req.query.sendMetrics === 'yes') {
      res.status(200).send("ok")
    } else {
      res.render('home', split)  
    }
  } else {
    let responseJSON = barChart.render().split("\n").map(function(x){return x.trim()}).join("\n");
    res.status(200).send(responseJSON)
  }  
}

var router = express.Router()
router.get('/', init)
router.post('/', init)

app.use("/", router)
app.set('port', (process.env.PORT || 3000) );

app.listen(app.get('port'), function() {
  console.log('server is running');
});