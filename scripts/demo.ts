import type { Subprocess } from "bun";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, ".vmrl-demo");
const sessionFile = join(directory, "session.json");
const cli = join(root, "packages/cli/index.ts");
const chainId = 31337;
const repository = "vmrl-demo/sample-app";

type Session = {
  rpc: string; contract: string; publisher: string; otherPublisher: string;
  original: string; modified: string; receipt: string; web: string;
};

async function command(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, expected = 0) {
  const child = Bun.spawn(args, { cwd, env, stdout: "inherit", stderr: "inherit" });
  const exit = await child.exited;
  if (exit !== expected) throw new Error(`${args[0]} ${args[1]} exited ${exit}; expected ${expected}`);
}

function verificationArgs(session: Session, artifact = session.original, signer = session.publisher, receipt = session.receipt) {
  return [process.execPath, cli, "verify", "--repo", repository, "--receipt", receipt, "--artifact", artifact, "--trusted-signer", signer];
}

function cliEnvironment(session: Session): NodeJS.ProcessEnv {
  return { ...process.env, VMRL_RPC_URL: session.rpc, VMRL_CHAIN_ID: String(chainId), VMRL_CONTRACT_ADDRESS: session.contract, VMRL_PRIVATE_KEY: "" };
}

async function check(session: Session) {
  const cases = [
    { name: "Original artifact + trusted publisher", args: verificationArgs(session), exit: 0 },
    { name: "Modified artifact", args: verificationArgs(session, session.modified), exit: 4 },
    { name: "Untrusted publisher", args: verificationArgs(session, session.original, session.otherPublisher), exit: 5 },
    { name: "Missing receipt", args: verificationArgs(session, session.original, session.publisher, "999999"), exit: 3 },
  ];
  for (const scenario of cases) {
    console.log(`\n--- ${scenario.name} (expected exit ${scenario.exit}) ---`);
    await command(scenario.args, root, cliEnvironment(session), scenario.exit);
  }
  console.log("\nAll four real-contract verification scenarios passed.");
}

function port(name: string, fallback: number) {
  const text = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(text) || Number(text) < 1024 || Number(text) > 65535) throw new Error(`${name} must be an integer from 1024 to 65535`);
  return Number(text);
}

async function available(port: number) {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`Port ${port} is busy. Stop that service or select VMRL_DEMO_RPC_PORT / VMRL_DEMO_WEB_PORT.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  });
}

async function launch() {
  const rpcPort = port("VMRL_DEMO_RPC_PORT", 8545);
  const webPort = port("VMRL_DEMO_WEB_PORT", 3000);
  if (rpcPort === webPort) throw new Error("RPC and web ports must be different");
  await Promise.all([available(rpcPort), available(webPort)]);
  if (!Bun.which("git")) throw new Error("Git is required to prepare the sample release checkout");
  // Use Ganache's supported JavaScript transport, avoiding native ABI dependencies on the presentation machine.
  process.env.UWS_USE_FALLBACK = "1";
  const [{ default: ganache }, { default: solc }] = await Promise.all([import("ganache"), import("solc")]);
  const server = ganache.server({
    chain: { chainId, hardfork: "shanghai" },
    wallet: { deterministic: true, totalAccounts: 2, defaultBalance: 1000 },
    logging: { quiet: true },
  });
  let web: Subprocess<"ignore", "inherit", "inherit"> | undefined;
  let provider: JsonRpcProvider | undefined;
  let stopping = false;
  const stopped = Promise.withResolvers<void>();
  const stop = async () => {
    if (stopping) return stopped.promise;
    stopping = true;
    console.log("\nStopping local demo services...");
    if (web && web.exitCode === null) {
      web.kill("SIGTERM");
      const timer = setTimeout(() => { if (web?.exitCode === null) web.kill("SIGKILL"); }, 5000);
      await web.exited;
      clearTimeout(timer);
    }
    provider?.destroy();
    await server.close();
    stopped.resolve();
  };
  const onSignal = () => { void stop(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await server.listen(rpcPort, "127.0.0.1");
    console.log(`Local-only EVM listening on 127.0.0.1:${rpcPort} (chain ${chainId}). No real funds or public chain used.`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const run = await mkdtemp(join(directory, "run-"));
    const sourceDirectory = join(run, "source");
    await mkdir(sourceDirectory);
    await Bun.write(join(sourceDirectory, "app.ts"), 'const release = { application: "VMRL sample app", version: "0.2.0" };\nconsole.log(`${release.application} ${release.version}`);\n');
    const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
    for (const args of [["init", "--quiet"], ["add", "app.ts"], ["-c", "user.name=VMRL Demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Build sample release"]]) {
      await command(["git", ...args], sourceDirectory, gitEnvironment);
    }
    const build = await Bun.build({ entrypoints: [join(sourceDirectory, "app.ts")], target: "bun", outdir: run, naming: "release.js", minify: true });
    if (!build.success) throw new AggregateError(build.logs, "Sample artifact build failed");
    const original = join(run, "release.js");
    const modified = join(run, "release-modified.js");
    // Exactly one appended byte changes the artifact identity without changing its filename label on-chain.
    await Bun.write(modified, Buffer.concat([await Bun.file(original).bytes(), Buffer.from("\n")]));
    console.log("Built real sample application; its modified copy differs by one byte.");
    await command([process.execPath, original], root);

    const compiled = JSON.parse(solc.compile(JSON.stringify({
      language: "Solidity", sources: { "VMRL.sol": { content: await Bun.file(join(root, "packages/contracts/src/VMRL.sol")).text() } },
      settings: { evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
    })));
    const failures = compiled.errors?.filter((error: { severity: string }) => error.severity === "error");
    if (failures?.length) throw new Error(JSON.stringify(failures));
    const artifact = compiled.contracts["VMRL.sol"].VMRL;
    const accounts = Object.values(server.provider.getInitialAccounts());
    const rpc = `http://127.0.0.1:${rpcPort}`;
    provider = new JsonRpcProvider(rpc);
    const publisher = new Wallet(accounts[0]!.secretKey, provider);
    const otherPublisher = new Wallet(accounts[1]!.secretKey);
    const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, publisher).deploy();
    const deployment = await contract.deploymentTransaction()!.wait();
    if (!deployment || deployment.status !== 1) throw new Error("Local contract deployment failed");
    const session: Session = { rpc, contract: await contract.getAddress(), publisher: publisher.address, otherPublisher: otherPublisher.address, original, modified, receipt: "0", web: `http://127.0.0.1:${webPort}` };
    await command([process.execPath, cli, "anchor", "--repo", repository, "--tag", "v0.2", "--artifact", original], sourceDirectory, { ...cliEnvironment(session), VMRL_PRIVATE_KEY: accounts[0]!.secretKey });
    // Prove the seeded receipt through the real CLI before declaring the demo ready.
    await check(session);
    await Bun.write(sessionFile, JSON.stringify(session, null, 2) + "\n");
    await Bun.write(join(run, "publisher-address.txt"), publisher.address + "\n");
    await Bun.write(join(run, "untrusted-address.txt"), otherPublisher.address + "\n");
    const webDirectory = join(root, "packages/web");
    const require = createRequire(join(webDirectory, "package.json"));
    const next = require.resolve("next/dist/bin/next");
    if (stopping) return;
    web = Bun.spawn([process.execPath, next, "dev", "--hostname", "127.0.0.1", "--port", String(webPort)], {
      cwd: webDirectory,
      env: { ...process.env, VMRL_PRIVATE_KEY: "", VMRL_LOCAL_DEMO: "1", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_VMRL_LOCAL_DEMO: "1", NEXT_PUBLIC_VMRL_RPC_URL: rpc, NEXT_PUBLIC_VMRL_CHAIN_ID: String(chainId), NEXT_PUBLIC_VMRL_CONTRACT_ADDRESS: session.contract, NEXT_PUBLIC_VMRL_START_BLOCK: String(deployment.blockNumber), NEXT_PUBLIC_VMRL_DEMO_PUBLISHER: publisher.address, NEXT_PUBLIC_VMRL_DEMO_OTHER_PUBLISHER: otherPublisher.address, VMRL_DEMO_ARTIFACT_DIR: run },
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    const deadline = Date.now() + 90000;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
      if (web.exitCode !== null) throw new Error(`Dashboard exited ${web.exitCode} before readiness`);
      try { ready = (await fetch(session.web, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* Server is still compiling. */ }
      if (ready) break;
      await Bun.sleep(250);
    }
    if (stopping) return;
    if (!ready) throw new Error("Dashboard did not become ready within 90 seconds");
    console.log(`\nVMRL LOCAL DEMO READY\nDashboard: ${session.web}\nOriginal:  ${original}\nModified:  ${modified}\nTrusted publisher:   ${publisher.address}\nUntrusted publisher: ${otherPublisher.address}\n\nOpen receipt #0, choose release.js, then enter the trusted publisher.\nReplace it with release-modified.js to show a digest mismatch.\nUse the untrusted address to show a separate publisher-policy failure.\nSecond terminal: bun run demo:check\nCtrl+C stops both services. Restarting creates a fresh chain and release.\nDevelopment wallets are public test identities: NEVER send real funds to them.\n`);
    if (!process.argv.includes("--no-open") && Bun.which("xdg-open")) {
      const opener = Bun.spawn(["xdg-open", session.web], { stdout: "ignore", stderr: "ignore" });
      void opener.exited;
    }
    await Promise.race([web.exited.then(code => { if (!stopping) throw new Error(`Dashboard stopped unexpectedly (exit ${code})`); }), stopped.promise]);
  } finally {
    await stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "check") {
    if (!await Bun.file(sessionFile).exists()) throw new Error("Start bun run demo in another terminal first");
    await check(await Bun.file(sessionFile).json() as Session);
  } else if (args.length === 0 || (args.length === 1 && args[0] === "--no-open")) {
    await launch();
  } else {
    throw new Error("Usage: bun run demo [--no-open] | bun run demo:check");
  }
} catch (error) {
  console.error(`Demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
