import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const directory = process.env.VMRL_DEMO_ARTIFACT_DIR;
  if (process.env.VMRL_LOCAL_DEMO !== "1" || !directory) {
    return new Response("Local demo is not running", { status: 404 });
  }
  const variant = new URL(request.url).searchParams.get("variant");
  if (variant !== "original" && variant !== "modified") {
    return new Response("Choose original or modified", { status: 400 });
  }
  const filename = variant === "original" ? "release.js" : "release-modified.js";
  try {
    const bytes = await readFile(join(directory, filename));
    return new Response(bytes, { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response("Demo artifact is unavailable; restart bun run demo", { status: 503 });
  }
}
