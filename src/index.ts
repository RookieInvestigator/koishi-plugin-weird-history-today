import { Context, Schema } from 'koishi'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

export const name = 'history-today'

export interface Config {
  dataFile: string
  authority: number
}

export const Config: Schema<Config> = Schema.object({
  dataFile: Schema.string()
    .description('数据文件路径（相对于插件根目录）')
    .default('data/history.json'),
  authority: Schema.number()
    .description('写入操作所需的最低权限等级')
    .default(3),
})

// 数据结构：{ "MM-DD": ["事件1", "事件2"] }
type HistoryData = Record<string, string[]>

// 每月最大天数（2月按29天算，兼容闰年）
const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const MAX_CONTENT_LENGTH = 200

function loadData(filePath: string): HistoryData {
  if (!existsSync(filePath)) return {}
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return {}
  }
}

function saveData(filePath: string, data: HistoryData) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function formatDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd}`
}

type ParseResult =
  | { ok: true; key: string }
  | { ok: false; error: string }

function parseDate(input: string): ParseResult {
  // 全角数字 → 半角
  const normalized = input.trim().replace(/[０-９]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  )

  const patterns = [
    /^(\d{1,2})[/\-](\d{1,2})$/,   // 03-15 / 3/15
    /^(\d{1,2})\.(\d{1,2})$/,       // 3.15
    /^(\d{1,2})月(\d{1,2})日?$/,    // 3月15日 / 3月15
  ]

  let m: RegExpMatchArray | null = null
  for (const p of patterns) {
    m = normalized.match(p)
    if (m) break
  }

  if (!m) {
    return { ok: false, error: '无法识别日期格式，支持：03-15、3/15、3.15、3月15日' }
  }

  const month = parseInt(m[1], 10)
  const day = parseInt(m[2], 10)

  if (month < 1 || month > 12) {
    return { ok: false, error: `月份 ${month} 不合法，应在 1~12 之间` }
  }
  if (day < 1 || day > DAYS_IN_MONTH[month]) {
    return { ok: false, error: `${month} 月最多 ${DAYS_IN_MONTH[month]} 天，没有第 ${day} 天` }
  }

  return {
    ok: true,
    key: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }
}

export function apply(ctx: Context, config: Config) {
  const filePath = resolve(__dirname, '..', config.dataFile)

  const history = ctx.command('history [date:string]', '查询历史上的今天')
    .alias('历史上的今天')
    .example('history          查询今天的历史事件')
    .example('history 03-15    查询3月15日的历史事件')
    .action((_, date) => {
      let key: string

      if (date) {
        const result = parseDate(date)
        if (!result.ok) return result.error
        key = result.key
      } else {
        key = formatDate(new Date())
      }

      const data = loadData(filePath)
      const events = data[key]
      if (!events || events.length === 0) {
        return `${key} 暂无历史事件记录`
      }

      const lines = events.map((e, i) => `${i + 1}. ${e}`)
      return `📅 ${key} 历史上的今天：\n${lines.join('\n')}`
    })

  history.subcommand('.add <date:string> <content:text>', '添加历史事件')
    .alias('history.添加')
    .authority(config.authority)
    .example('history.add 03-15 1493年，哥伦布返回西班牙')
    .action((_, date, content) => {
      const result = parseDate(date)
      if (!result.ok) return result.error

      const text = content.trim()
      if (!text) return '事件内容不能为空'
      if (text.length > MAX_CONTENT_LENGTH) {
        return `内容过长（${text.length} 字），最多 ${MAX_CONTENT_LENGTH} 字`
      }

      const data = loadData(filePath)
      if (!data[result.key]) data[result.key] = []

      if (data[result.key].includes(text)) {
        return `该事件已存在，无需重复添加：${text}`
      }

      data[result.key].push(text)
      saveData(filePath, data)

      return `已添加：[${result.key}] ${text}`
    })

  history.subcommand('.remove <date:string> <index:posint>', '删除历史事件（序号从1开始）')
    .alias('history.删除')
    .authority(config.authority)
    .example('history.remove 03-15 2    删除3月15日第2条记录')
    .action((_, date, index) => {
      const result = parseDate(date)
      if (!result.ok) return result.error

      const data = loadData(filePath)
      const events = data[result.key]

      if (!events || events.length === 0) {
        return `${result.key} 暂无历史事件记录`
      }
      if (index < 1 || index > events.length) {
        return `序号 ${index} 超出范围，${result.key} 共有 ${events.length} 条记录（1~${events.length}）`
      }

      const [removed] = events.splice(index - 1, 1)
      if (events.length === 0) delete data[result.key]
      saveData(filePath, data)

      return `已删除：[${result.key}] ${removed}`
    })

  history.subcommand('.list [date:string]', '列出指定日期所有事件（带序号，便于删除）')
    .authority(config.authority)
    .action((_, date) => {
      let key: string

      if (date) {
        const result = parseDate(date)
        if (!result.ok) return result.error
        key = result.key
      } else {
        key = formatDate(new Date())
      }

      const data = loadData(filePath)
      const events = data[key]
      if (!events || events.length === 0) return `${key} 暂无历史事件记录`

      const lines = events.map((e, i) => `${i + 1}. ${e}`)
      return `📅 ${key} 共 ${events.length} 条：\n${lines.join('\n')}`
    })
}
