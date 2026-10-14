/** Read-only: is `permission.request.list({})` valid, or does it need a sessionID? */
const { OpenCode } = await import("@opencode/client/promise");
const { headers, Service } = await import("@opencode/client/service");
const ep = await Service.discover();
if (!ep) throw new Error("no service");
const oc = OpenCode.make({ baseUrl: ep.url, headers: headers(ep) });
const unwrap = (r: any) => (r && typeof r === "object" && "data" in r ? r.data : r);

const raw = unwrap(await oc.session.list({}));
const list: any[] = Array.isArray(raw) ? raw : (raw?.data ?? []);
const sid = list[0]?.id;
console.log("sample session:", sid);

async function try_(label: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    const v = unwrap(r);
    console.log(`${label}: OK ->`, JSON.stringify(v).slice(0, 160));
  } catch (cause) {
    console.log(`${label}: THREW ->`, cause instanceof Error ? cause.message : String(cause));
  }
}

await try_("list({})", () => oc.permission.request.list({} as never));
await try_(`list({sessionID})`, () => oc.permission.request.list({ sessionID: sid } as never));

console.log("=== shape of session.list ===");
try {
  const r: any = await oc.session.list({});
  console.log("   isArray:", Array.isArray(r), "| keys:", Object.keys(r ?? {}).slice(0, 5));
} catch (cause) {
  console.log("   threw:", cause instanceof Error ? cause.message : cause);
}
