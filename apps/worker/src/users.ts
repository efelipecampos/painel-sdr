// Dá acesso ao painel a usuários já criados no Supabase Auth (Authentication → Users → Add user).
// Uso: npm run usuarios -w @painel/worker -- email:papel:Nome [email:papel:Nome ...]
// papel = admin | gestor | sdr. Não cria nem altera senha: só grava painel.profiles.
// Para sdr, o login é ligado ao SDR (painel.sdrs) pelo mesmo e-mail da Poli.
import { createDb } from "./processor.js";

const db = createDb();
const args = process.argv.slice(2);
if (!args.length) {
  console.error("Uso: npm run usuarios -w @painel/worker -- email:papel:Nome ...");
  process.exit(1);
}

const users = new Map<string, string>();
for (let page = 1; ; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw new Error(`Não foi possível listar os usuários: ${error.message}`);
  for (const u of data.users) if (u.email) users.set(u.email.toLowerCase(), u.id);
  if (data.users.length < 1000) break;
}

let failed = false;
for (const arg of args) {
  const [email, role, ...rest] = arg.split(":");
  const name = rest.join(":").trim();
  const id = users.get(email.trim().toLowerCase());
  if (!id) { console.error(`✗ ${email}: usuário não existe no Supabase Auth. Crie em Authentication → Users → Add user.`); failed = true; continue; }
  if (role !== "admin" && role !== "gestor" && role !== "sdr") { console.error(`✗ ${email}: papel precisa ser admin, gestor ou sdr.`); failed = true; continue; }
  if (!name) { console.error(`✗ ${email}: falta o nome.`); failed = true; continue; }
  let sdrId: string | null = null;
  if (role === "sdr") {
    const { data: s } = await db.schema("painel").from("sdrs").select("id, role").eq("poli_email", email.trim().toLowerCase()).maybeSingle();
    if (!s || s.role !== "sdr") { console.error(`✗ ${email}: não é SDR nas listas do painel (POLI_SDR_EMAILS).`); failed = true; continue; }
    sdrId = s.id;
  }
  const { error } = await db.schema("painel").from("profiles").upsert({ id, name, role, sdr_id: sdrId, active: true });
  if (error) { console.error(`✗ ${email}: ${error.message}`); failed = true; continue; }
  console.log(`✓ ${email}: ${name} (${role})`);
}
process.exit(failed ? 1 : 0);
