const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
 
const BOT_TOKEN = process.env.BOT_TOKEN || '8604088978:AAGXigZkPImvGhEZf2d8kDc9fdDU_8fpmOo';
const SB_URL    = process.env.SB_URL    || 'https://aadrzgxwfaapfyqbldzz.supabase.co';
const SB_KEY    = process.env.SB_KEY    || 'sb_secret_PKzZ1fLja56EpghCr710bg_1HtYZnLi';
const APP_URL   = process.env.APP_URL   || 'https://adorable-yeot-f3c652.netlify.app';
 
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const sb  = createClient(SB_URL, SB_KEY);
 
// ── /start — сохраняем chat_id и открываем приложение ────────
bot.onText(/\/start/, async (msg) => {
  const chatId   = msg.chat.id;
  const tgName   = msg.from.first_name || '';
  const username = msg.from.username   || '';
 
  // Сохраняем chat_id для всех участников с похожим именем
  // Если не нашли — создаём запись-заглушку чтобы потом связать
  const { data: existing } = await sb
    .from('tg_users')
    .select('id')
    .eq('chat_id', chatId)
    .maybeSingle();
 
  if (!existing) {
    await sb.from('tg_users').insert({
      chat_id:  chatId,
      tg_name:  tgName,
      username: username,
    });
  }
 
  // Обновляем chat_id у участников если username совпадает
  if (username) {
    await sb.from('members')
      .update({ telegram_chat_id: chatId })
      .ilike('name', `%${tgName}%`);
  }
 
  await bot.sendMessage(chatId,
    `👋 Привет, ${tgName}!\n\n` +
    `*FlexBoard* — управление проектами для твоей команды.\n\n` +
    `Здесь ты будешь получать уведомления о задачах, дедлайнах и прогрессе проекта.\n\n` +
    `Нажми кнопку ниже чтобы открыть приложение 👇`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🚀 Открыть FlexBoard', web_app: { url: APP_URL } }
        ]]
      }
    }
  );
});
 
// ── Обрабатываем данные из Mini App ──────────────────────────
// Когда пользователь открывает мини-апп через бота
// Telegram передаёт web_app_data с chat_id автоматически
bot.on('message', async (msg) => {
  if (!msg.web_app_data) return;
 
  const chatId = msg.chat.id;
  const data   = msg.web_app_data.data;
 
  try {
    const parsed = JSON.parse(data);
    // Если приложение передало project_id и member_name — связываем
    if (parsed.project_id && parsed.member_name) {
      await sb.from('members')
        .update({ telegram_chat_id: chatId })
        .eq('project_id', parsed.project_id)
        .ilike('name', `%${parsed.member_name}%`);
    }
  } catch(e) {
    // ignore
  }
});
 
// ── HELPERS ──────────────────────────────────────────────────
async function getAllProjects() {
  const { data } = await sb.from('projects').select('*');
  return data || [];
}
 
async function getProjectMembers(projectId, roles) {
  const { data } = await sb
    .from('members')
    .select('*')
    .eq('project_id', projectId)
    .in('role', roles)
    .not('telegram_chat_id', 'is', null);
  return data || [];
}
 
async function getProjectTasks(projectId) {
  const { data } = await sb.from('tasks').select('*').eq('project_id', projectId);
  return data || [];
}
 
function formatBar(pct) {
  return '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
}
 
// ── ЕЖЕДНЕВНОЕ САММАРИ (20:00 МСК = 17:00 UTC) ───────────────
async function sendDailySummary() {
  console.log('[CRON] Daily summary...');
  const projects = await getAllProjects();
 
  for (const p of projects) {
    const tasks   = await getProjectTasks(p.id);
    const total   = tasks.length;
    const done    = tasks.filter(t => t.status === 'done').length;
    const doing   = tasks.filter(t => t.status === 'doing').length;
    const todo    = tasks.filter(t => t.status === 'todo').length;
    const pct     = total ? Math.round(done / total * 100) : 0;
    const urgent  = tasks.filter(t => t.is_urgent && t.status !== 'done').length;
    const today   = new Date().toISOString().slice(0, 10);
    const overdue = tasks.filter(t => t.deadline && t.status !== 'done' && t.deadline < today).length;
 
    const text =
      `📊 *Отчёт — ${p.emoji || ''} ${p.name}*\n\n` +
      `${formatBar(pct)} ${pct}%\n\n` +
      `✅ Готово: *${done}* из ${total}\n` +
      `🔄 В работе: *${doing}*\n` +
      `📋 К выполнению: *${todo}*` +
      (urgent  ? `\n⚡ Срочных: *${urgent}*`   : '') +
      (overdue ? `\n⚠️ Просрочено: *${overdue}*` : '') +
      `\n\n_${new Date().toLocaleDateString('ru-RU', { day:'numeric', month:'long' })}_`;
 
    const recipients = await getProjectMembers(p.id, ['founder', 'investor']);
    for (const m of recipients) {
      try {
        await bot.sendMessage(m.telegram_chat_id, text, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '📱 Открыть проект', web_app: { url: APP_URL } }]] }
        });
      } catch(e) { console.error('Summary error:', e.message); }
    }
  }
}
 
// ── НАПОМИНАНИЯ О ДЕДЛАЙНАХ (09:00 МСК = 06:00 UTC) ──────────
async function sendDeadlineReminders() {
  console.log('[CRON] Deadline reminders...');
  const projects = await getAllProjects();
  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
 
  for (const p of projects) {
    const { data: tasks } = await sb
      .from('tasks').select('*')
      .eq('project_id', p.id)
      .neq('status', 'done')
      .not('deadline', 'is', null);
 
    if (!tasks) continue;
 
    for (const task of tasks) {
      if (task.deadline !== today && task.deadline !== tomorrowStr) continue;
      const label = task.deadline === today ? '🔴 сегодня' : '🟡 завтра';
 
      const members = await getProjectMembers(p.id, ['founder', 'member', 'expert', 'investor']);
      for (const m of members) {
        try {
          await bot.sendMessage(m.telegram_chat_id,
            `⏰ *Дедлайн ${label}*\n\n📌 ${task.title}\n📁 ${p.emoji || ''} ${p.name}`,
            { parse_mode: 'Markdown' }
          );
        } catch(e) { console.error('Deadline error:', e.message); }
      }
    }
  }
}
 
// ── УВЕДОМЛЕНИЕ О ВЫПОЛНЕННЫХ ЗАДАЧАХ (каждые 2 мин) ─────────
let lastChecked = new Date(Date.now() - 2 * 60 * 1000).toISOString();
 
async function checkCompletedTasks() {
  const projects = await getAllProjects();
 
  for (const p of projects) {
    const { data: tasks } = await sb
      .from('tasks').select('*')
      .eq('project_id', p.id)
      .eq('status', 'done')
      .gt('updated_at', lastChecked);
 
    if (!tasks || tasks.length === 0) continue;
 
    const recipients = await getProjectMembers(p.id, ['founder', 'investor']);
 
    for (const task of tasks) {
      for (const m of recipients) {
        try {
          await bot.sendMessage(m.telegram_chat_id,
            `✅ *Задача выполнена!*\n\n📌 ${task.title}\n📁 ${p.emoji || ''} ${p.name}`,
            {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[{ text: '📱 Открыть проект', web_app: { url: APP_URL } }]] }
            }
          );
        } catch(e) { console.error('Task done error:', e.message); }
      }
    }
  }
 
  lastChecked = new Date().toISOString();
}
 
// ── CRON ─────────────────────────────────────────────────────
cron.schedule('0 17 * * *', sendDailySummary);      // 20:00 МСК
cron.schedule('0 6 * * *',  sendDeadlineReminders); // 09:00 МСК
cron.schedule('*/2 * * * *', checkCompletedTasks);  // каждые 2 мин
 
console.log('✅ FlexBoard bot started!');
