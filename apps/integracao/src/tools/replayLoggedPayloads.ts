/**
 * Reprocessa mensagens que foram rejeitadas pelo schema e ficaram só no log
 * (linhas "Payload da Poli não bateu com o schema esperado", que carregam o
 * corpo completo). Idempotente: pula o que já foi processado.
 *
 * Dentro do container:
 *   docker exec -i poli-hubspot node dist/tools/replayLoggedPayloads.js < arquivo.log
 */
import { poliWebhookBodySchema } from "../poli/types.js";
import { parseMessageEvent } from "../poli/parser.js";
import { processMessage } from "../pipeline/processMessage.js";
import { isAlreadyProcessed, markProcessed } from "../queue/store.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const lines = (await readStdin()).split("\n").filter((l) => l.includes("não bateu com o schema"));
  console.log(`${lines.length} payloads rejeitados no log.`);

  for (const line of lines) {
    let body: unknown;
    try {
      body = JSON.parse(line).body;
    } catch {
      continue;
    }
    const parsed = poliWebhookBodySchema.safeParse(body);
    if (!parsed.success) {
      console.log("  ignorado (continua fora do schema):", JSON.stringify(parsed.error.issues).slice(0, 200));
      continue;
    }
    const message = parseMessageEvent(parsed.data);
    if (isAlreadyProcessed(message.externalMessageId)) {
      console.log(`  ${message.externalMessageId}: já processada`);
      continue;
    }
    const result = await processMessage(message);
    markProcessed(message.externalMessageId);
    console.log(`  ${message.externalMessageId} (${message.direction}): ${result.outcome}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
