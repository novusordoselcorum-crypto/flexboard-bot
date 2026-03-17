const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// ── CONFIG ───────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || '8604088978:AAGXigZkPImvGhEZf2d8kDc9fdDU_8fpmOo';
const SB_URL    = process.env.SB_URL    || 'https://aadrzgxwfaapfyqbldzz.supabase.co';
const SB_KEY    = process.env.SB_KEY    || 'sb_secret_PKzZ1fLja56EpghCr710bg_1HtYZnLi';
const APP_URL   = process.env.APP_URL   || 'https://adorable-yeot-f3c652.netlify.app';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const sb  = createClient(SB_URL, SB_KEY);

// ── WELCOME ──────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const name   = msg.from.first_name || 'друг';

  // Save chat_id if member exists with same first name
  await sb.from('members')
    .update({ telegram_chat_id: chatId })
    .ilike('name', `${name}%`);

  await bot.sendMessage(chatId,
    `👋 Привет, ${name}!\n\n` +
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

// ── HELPERS ──────────────────────────────────────────────────
async function getProjectMembers(projectId, roles) {
  const { data } = await sb
    .from('members')
    .select('*')
    .eq('project_id', projectId)
    .in('role', roles)
    .not('telegram_chat_id', 'is', null);
  return data || [];
}

async function getAllProjects() {
  const { data } = await sb.from('projects').select('*');
  return data || [];
}

async function getProjectTasks(projectId) {
  const { data } = await sb.from('tasks').select('*').eq('project_id', projectId);
  return data || [];
}

async function getProjectSettings(projectId) {
  const { data } = await sb.from('tg_settings').select('*').eq('project_id', projectId);
  return data || [];
}

function formatProgress(tasks) {
  const total = tasks.length;
  const done  = tasks.filter(t => t.status === 'done').length;
  const doing = tasks.filter(t => t.status === 'doing').length;
  const todo  = tasks.filter(t => t.status === 'todo').length;
  const pct   = total ? Math.round(done / total * 100) : 0;
  const bar   = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
  return { total, done, doing, todo, pct, bar };
}

// ── DAILY SUMMARY ────────────────────────────────────────────
async function sendDailySummary() {
  console.log('Sending daily summaries...');
  const projects = await getAllProjects();

  for (const project of projects) {
    const tasks    = await getProjectTasks(project.id);
    const { total, done, doing, todo, pct, bar } = formatProgress(tasks);

    // Find urgent tasks
    const urgent = tasks.filter(t => t.is_urgent && t.status !== 'done');

    // Find overdue (deadline today or past)
    const today = new Date().toISOString().slice(0, 10);
    const overdue = tasks.filter(t => t.deadline && t.status !== 'done' && t.deadline < today);

    const text =
      `📊 *Ежедневный отчёт — ${project.emoji || ''} ${project.name}*\n\n` +
      `${bar} ${pct}%\n\n` +
      `✅ Готово: *${done}* из ${total}\n` +
      `🔄 В работе: *${doing}*\n` +
      `📋 К выполнению: *${todo}*\n` +
      (urgent.length   ? `\n⚡ Срочных задач: *${urgent.length}*` : '') +
      (overdue.length  ? `\n⚠️ Просрочено: *${overdue.length}*`   : '') +
      `\n\n_${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}_`;

    // Send to founders and investors
    const recipients = await getProjectMembers(project.id, ['founder', 'investor']);
    for (const member of recipients) {
      try {
        await bot.sendMessage(member.telegram_chat_id, text, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '📱 Открыть проект', web_app: { url: APP_URL } }
            ]]
          }
        });
      } catch (e) {
        console.error(`Failed to send to ${member.name}:`, e.message);
      }
    }
  }
}

// ── DEADLINE REMINDERS ───────────────────────────────────────
async function sendDeadlineReminders() {
  console.log('Checking deadlines...');
  const projects = await getAllProjects();
  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  for (const project of projects) {
    const { data: tasks } = await sb
      .from('tasks')
      .select('*')
      .eq('project_id', project.id)
      .neq('status', 'done')
      .not('deadline', 'is', null);

    if (!tasks) continue;

    for (const task of tasks) {
      if (task.deadline !== todayStr && task.deadline !== tomorrowStr) continue;

      const isToday    = task.deadline === todayStr;
      const label      = isToday ? '🔴 сегодня' : '🟡 завтра';

      // Notify all members of the project
      const members = await getProjectMembers(project.id, ['founder', 'member', 'expert']);
      for (const member of members) {
        try {
          await bot.sendMessage(
            member.telegram_chat_id,
            `⏰ *Дедлайн ${label}*\n\n` +
            `📌 ${task.title}\n` +
            `📁 ${project.emoji || ''} ${project.name}`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          console.error(`Deadline notify failed for ${member.name}:`, e.message);
        }
      }
    }
  }
}

// ── TASK DONE NOTIFICATIONS ──────────────────────────────────
let lastCheckedAt = new Date().toISOString();

async function checkCompletedTasks() {
  const projects = await getAllProjects();

  for (const project of projects) {
    const { data: tasks } = await sb
      .from('tasks')
      .select('*')
      .eq('project_id', project.id)
      .eq('status', 'done')
      .gt('updated_at', lastCheckedAt);

    if (!tasks || tasks.length === 0) continue;

    const recipients = await getProjectMembers(project.id, ['founder', 'investor']);
    for (const task of tasks) {
      for (const member of recipients) {
        try {
          await bot.sendMessage(
            member.telegram_chat_id,
            `✅ *Задача выполнена!*\n\n` +
            `📌 ${task.title}\n` +
            `📁 ${project.emoji || ''} ${project.name}`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '📱 Открыть проект', web_app: { url: APP_URL } }
                ]]
              }
            }
          );
        } catch (e) {
          console.error(`Task done notify failed:`, e.message);
        }
      }
    }
  }

  lastCheckedAt = new Date().toISOString();
}

// ── CRON JOBS ────────────────────────────────────────────────
// Daily summary at 20:00 Moscow time (17:00 UTC)
cron.schedule('0 17 * * *', sendDailySummary);

// Deadline reminders at 09:00 Moscow time (06:00 UTC)
cron.schedule('0 6 * * *', sendDeadlineReminders);

// Check completed tasks every 5 minutes
cron.schedule('*/5 * * * *', checkCompletedTasks);

// ── START ────────────────────────────────────────────────────
console.log('FlexBoard bot started!');
console.log('App URL:', APP_URL);
