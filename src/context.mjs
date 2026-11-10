import { hhmm } from './core.mjs';
import { nameOf } from './members.mjs';

export function formatDialogue({ messages, episodes }, members, speakerId) {
  const lines = messages.map((message) => {
    const speaker = message.self ? '你（金桦）' : message.n;
    const text = message.c?.slice(0, 360) || '（发了东西）';
    const attachments = message.att?.length ? ' [' + message.att.map((item) => item.t).join(',') + ']' : '';
    return hhmm(message.ts) + ' ' + speaker + '：' + text + attachments;
  });
  const people = [...new Set([speakerId, ...messages.slice(-8).map((message) => message.u)].filter(Boolean))].slice(0, 4);
  return [
    '【当前会话（最近' + lines.length + '条）】\n' + (lines.join('\n') || '（暂时没有聊天记录）'),
    episodes.length ? '【可能相关的旧事】\n' + episodes.map((item) => '· ' + item.text).join('\n') : '',
    people.length ? '【在场的人】\n' + people.map((id) => '· ' + nameOf(id, '', members)).join('\n') : '',
  ].filter(Boolean).join('\n\n');
}

export function planningContext({ messages }) {
  return messages.filter((message) => message.c).slice(-6).map((message) => ({
    speaker: message.self ? '金桦' : message.n,
    text: message.c.slice(0, 240),
  }));
}
