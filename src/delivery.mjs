import { addSelf } from './memory.mjs';
import { sendLines } from './outbox.mjs';

export async function deliver(options) {
  const key = options.scope === 'c2c' ? 'c2c:' + options.openid : options.group;
  const delivered = [];
  for (const receipt of await sendLines(options)) {
    if (!receipt.ok) continue;
    addSelf(key, receipt.text, { id: receipt.id, sourceId: receipt.sourceId, turnId: receipt.turnId });
    delivered.push(receipt.text);
  }
  return delivered;
}
