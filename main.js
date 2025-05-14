// main.js
import { InstanceBase, runEntrypoint, InstanceStatus } from '@companion-module/base'
import WebSocket from 'ws'
import objectPath from 'object-path'
import { createHash } from 'crypto'

// no migrations for now
export const upgradeScripts = []

class LiveGradeInstance extends InstanceBase {
  constructor(internal) {
    super(internal)
    this.ws = null
    this.reconnectTimer = null
    this.lastAuthCode = null
    this.slots = []
    this.looks = []
  }

  getConfigFields() {
    return [
      { id: 'host', type: 'textinput', label: 'LiveGrade IP', default: '', width: 6 },
      { id: 'port', type: 'textinput', label: 'Port',     default: '9000', width: 3 },
    ]
  }

  async init(config) {
    this.config = config
    this.updateStatus(InstanceStatus.Connecting)
    this._connectWebSocket()
  }

  async configUpdated(config) {
    this.config = config
    if (this.ws) this.ws.close()
    this.updateStatus(InstanceStatus.Connecting)
    this._connectWebSocket()
  }

  destroy() {
    if (this.ws) this.ws.close()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.updateStatus(InstanceStatus.Disconnected)
  }

  _connectWebSocket() {
    const host = (this.config.host||'').trim()
    const port = String(this.config.port||'9000').trim()
    if (!host) {
      this.updateStatus(InstanceStatus.BadConfig, 'Enter server IP')
      return
    }

    const url = `ws://${host}:${port}`
    this.log('info', `→ Connecting to ${url}`)
    try {
      this.ws = new WebSocket(url, ['livegrade-live-updates'])
      this.ws.on('open', () => {
        this.updateStatus(InstanceStatus.Ok)
        this.log('info', `WebSocket opened to ${url}`)
      })
      this.ws.on('message', msg => this._onWsMessage(msg.toString()))
      this.ws.on('error', err => {
        this.log('error', `WS error: ${err.message}`)
        this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
        this._scheduleReconnect()
      })
      this.ws.on('close', () => {
        this.log('warn', 'WS closed, scheduling reconnect')
        this._scheduleReconnect()
      })
    } catch (e) {
      this.log('error', `Connect failed: ${e.message}`)
      this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
      this._scheduleReconnect()
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this._connectWebSocket(), 5000)
  }

  _onWsMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.type === 'authentication' && msg.subtype === 'challenge') {
      const chal = msg.arguments.challenge
      this.log('info', `🔐 Challenge: ${chal}`)
      const code = this._computeAuth(chal)
      this.lastAuthCode = code
      this.log('info', `🛠 Auth code: ${code}`)
      this.ws.send(JSON.stringify({
        type: 'authentication',
        subtype: 'response',
        arguments: { response: code, device: 'Companion' }
      }))
    }
    else if (msg.type === 'authentication' && msg.subtype === 'result') {
      if (msg.arguments.success) {
        this.log('info', '✅ Auth OK, fetching slots & looks…')
        this._fetchSlotsAndLooks()
      } else {
        this.log('error', '❌ Auth failed, closing')
        this.ws.close()
      }
    }
  }

  _computeAuth(challenge) {
    // same salt order as ObjC
    const salt =
      'SwPx0b' +
      'jRFqVWm6' +
      'LCQ8et9h' +
      'hYt26L8G' +  // reversed %d args
      'ktOVB8d1R'
    const h = createHash('md5')
    h.update(challenge + salt)
    return h.digest('hex').toUpperCase()
  }

  async _fetchSlotsAndLooks() {
    const host = this.config.host.trim()
    const port = String(this.config.port||'9000').trim()
    const auth = this.lastAuthCode
    try {
      // fetch slots
      let res = await fetch(`http://${host}:${port}/devices/slots?auth=${auth}`)
      let body = await res.json()
      this.slots = body.result || []
      // fetch looks
      res = await fetch(`http://${host}:${port}/library/grades?auth=${auth}`)
      body = await res.json()
      this.looks = body.result || []

      this._buildApplyAction()
    } catch (e) {
      this.log('error', `Fetch error: ${e.message}`)
    }
  }

  _buildApplyAction() {
    const slotChoices = this.slots.map(s => ({
      id: String(s.index),
      label: s.label || `Slot ${s.index}`
    }))
    const lookChoices = this.looks.map(l => ({
      id: l.uid,
      label: l.name
    }))
    this.setActionDefinitions({
      applyGrade: {
        name: 'Apply grade to slot',
        options: [
          { id: 'slot', type: 'dropdown', label: 'Slot', choices: slotChoices },
          { id: 'look', type: 'dropdown', label: 'Look', choices: lookChoices }
        ],
        callback: action => {
  const slot = parseInt(action.options.slot)
  const uid = action.options.look

  const changeCmd = {
    type: 'command',
    subtype: 'changeDevice',
    arguments: { index: slot }
  }

  const applyCmd = {
    type: 'command',
    subtype: 'applyGrade',
    arguments: { uid }
  }

  // First, change the slot
  this.log('info', `→ Changing to slot ${slot}`)
  this.ws.send(JSON.stringify(changeCmd))

  // Then, apply the LUT immediately
  this.log('info', `→ Applying UID ${uid} to slot ${slot}`)
  this.ws.send(JSON.stringify(applyCmd))

  // Now, delay to give the system time before next command is sent
  setTimeout(() => {
    this.log('info', `→ Delay complete after applying grade to slot ${slot}`)
    // You can leave this empty, or use it for future chaining
  }, 500)
},
      },
    })
  }
}

runEntrypoint(LiveGradeInstance, upgradeScripts)