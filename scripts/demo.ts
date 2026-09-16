import type { Subprocess } from "bun";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Deferred, Effect } from "effect";
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

class DemoError extends Data.TaggedError("DemoError")<{ readonly message: string }> {}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const fail = (message: string): Effect.Effect<never, DemoError> => Effect.fail(new DemoError({ message }));
const attempt = <A>(thunk: () => Promise<A>): Effect.Effect<A, DemoError> =>
  Effect.tryPromise({ try: thunk, catch: (error) => new DemoError({ message: errorText(error) }) });
// Finalizers must not fail, so release errors are dropped after cleanup is attempted.
const release = <A>(thunk: () => Promise<A>) => attempt(thunk).pipe(Effect.catchAllCause(() => Effect.void));

const command = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, expected = 0): Effect.Effect<void, DemoError> =>
  Effect.gen(function* () {
    const child = Bun.spawn(args, { cwd, env, stdout: "inherit", stderr: "inherit" });
    const exit = yield* attempt(() => child.exited);
    if (exit !== expected) return yield* fail(`${args[0]} ${args[1]} exited ${exit}; expected ${expected}`);
  });

function verificationArgs(session: Session, artifact = session.original, signer = session.publisher, receipt = session.receipt) {
  return [process.execPath, cli, "verify", "--repo", repository, "--receipt", receipt, "--artifact", artifact, "--trusted-signer", signer];
}

function cliEnvironment(session: Session): NodeJS.ProcessEnv {
  return { ...process.env, VMRL_RPC_URL: session.rpc, VMRL_CHAIN_ID: String(chainId), VMRL_CONTRACT_ADDRESS: session.contract, VMRL_PRIVATE_KEY: "" };
}

const check = (session: Session): Effect.Effect<void, DemoError> =>
  Effect.gen(function* () {
    const cases = [
      { name: "Original artifact + trusted publisher", args: verificationArgs(session), exit: 0 },
      { name: "Modified artifact", args: verificationArgs(session, session.modified), exit: 4 },
      { name: "Untrusted publisher", args: verificationArgs(session, session.original, session.otherPublisher), exit: 5 },
      { name: "Missing receipt", args: verificationArgs(session, session.original, session.publisher, "999999"), exit: 3 },
    ];
    for (const scenario of cases) {
      console.log(`\n--- ${scenario.name} (expected exit ${scenario.exit}) ---`);
      yield* command(scenario.args, root, cliEnvironment(session), scenario.exit);
    }
    console.log("\nAll four real-contract verification scenarios passed.");
  });

const parsePort = (name: string, fallback: number): Effect.Effect<number, DemoError> =>
  Effect.gen(function* () {
    const text = process.env[name] ?? String(fallback);
    if (!/^\d+$/.test(text) || Number(text) < 1024 || Number(text) > 65535) return yield* fail(`${name} must be an integer from 1024 to 65535`);
    return Number(text);
  });

const available = (port: number): Effect.Effect<void, DemoError> =>
  attempt(() => new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`Port ${port} is busy. Stop that service or select VMRL_DEMO_RPC_PORT / VMRL_DEMO_WEB_PORT.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  }));

// Generated builds are disposable; keep only the most recent runs so the directory cannot grow without bound.
async function pruneRuns(base: string, keep: number) {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return;
  }
  const runs = await Promise.all(entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith("run-"))
    .map(async entry => ({ name: entry.name, time: (await stat(join(base, entry.name))).mtimeMs })));
  runs.sort((left, right) => left.time - right.time);
  for (const stale of runs.slice(0, Math.max(0, runs.length - keep))) {
    await rm(join(base, stale.name), { recursive: true, force: true });
  }
}

const launch = Effect.gen(function* () {
  const rpcPort = yield* parsePort("VMRL_DEMO_RPC_PORT", 8545);
  const webPort = yield* parsePort("VMRL_DEMO_WEB_PORT", 3000);
  if (rpcPort === webPort) return yield* fail("RPC and web ports must be different");
  yield* Effect.all([available(rpcPort), available(webPort)], { concurrency: 2 });
  if (!Bun.which("git")) return yield* fail("Git is required to prepare the sample release checkout");
  // Use Ganache's supported JavaScript transport, avoiding native ABI dependencies on the presentation machine.
  process.env.UWS_USE_FALLBACK = "1";
  const [{ default: ganache }, { default: solc }] = yield* attempt(() => Promise.all([import("ganache"), import("solc")]));

  const stopSignal = yield* Deferred.make<void>();
  const signals = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const flag = { value: false };
      const handler = () => {
        if (flag.value) return;
        flag.value = true;
        console.log("\nStopping local demo services...");
        Effect.runSync(Deferred.succeed(stopSignal, undefined));
      };
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
      return { flag, handler };
    }),
    ({ handler }) => Effect.sync(() => {
      process.removeListener("SIGINT", handler);
      process.removeListener("SIGTERM", handler);
    }),
  );

  const server = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const instance = ganache.server({
        chain: { chainId, hardfork: "shanghai" },
        wallet: { deterministic: true, totalAccounts: 2, defaultBalance: 1000 },
        logging: { quiet: true },
      });
      yield* attempt(() => instance.listen(rpcPort, "127.0.0.1"));
      return instance;
    }),
    (instance) => release(() => instance.close()),
  );

  console.log(`Local-only EVM listening on 127.0.0.1:${rpcPort} (chain ${chainId}). No real funds or public chain used.`);
  yield* attempt(() => mkdir(directory, { recursive: true, mode: 0o700 }));
  const run = yield* attempt(() => mkdtemp(join(directory, "run-")));
  yield* attempt(() => pruneRuns(directory, 5));
  const sourceDirectory = join(run, "source");
  yield* attempt(() => mkdir(sourceDirectory));
  yield* attempt(() => Bun.write(join(sourceDirectory, "app.ts"), 'const release = { application: "VMRL sample app", version: "0.2.0" };\nconsole.log(`${release.application} ${release.version}`);\n'));
  const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  for (const args of [["init", "--quiet"], ["add", "app.ts"], ["-c", "user.name=VMRL Demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Build sample release"]]) {
    yield* command(["git", ...args], sourceDirectory, gitEnvironment);
  }
  const build = yield* attempt(() => Bun.build({ entrypoints: [join(sourceDirectory, "app.ts")], target: "bun", outdir: run, naming: "release.js", minify: true }));
  if (!build.success) return yield* fail("Sample artifact build failed");
  const original = join(run, "release.js");
  const modified = join(run, "release-modified.js");
  // Exactly one appended byte changes the artifact identity without changing its filename label on-chain.
  const originalBytes = yield* attempt(() => Bun.file(original).bytes());
  yield* attempt(() => Bun.write(modified, Buffer.concat([originalBytes, Buffer.from("\n")])));
  console.log("Built real sample application; its modified copy differs by one byte.");
  yield* command([process.execPath, original], root);

  const source = yield* attempt(() => Bun.file(join(root, "packages/contracts/src/VMRL.sol")).text());
  const compiled = yield* Effect.try({
    try: () => JSON.parse(solc.compile(JSON.stringify({
      language: "Solidity", sources: { "VMRL.sol": { content: source } },
      settings: { evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
    }))),
    catch: (error) => new DemoError({ message: errorText(error) }),
  });
  const failures = compiled.errors?.filter((error: { severity: string }) => error.severity === "error");
  if (failures?.length) return yield* fail(JSON.stringify(failures));
  const artifact = compiled.contracts["VMRL.sol"].VMRL;
  const accounts = Object.values(server.provider.getInitialAccounts()) as Array<{ secretKey: string }>;
  const rpc = `http://127.0.0.1:${rpcPort}`;
  const provider = yield* Effect.acquireRelease(
    Effect.sync(() => new JsonRpcProvider(rpc)),
    (instance) => Effect.sync(() => instance.destroy()),
  );
  const publisher = new Wallet(accounts[0]!.secretKey, provider);
  const otherPublisher = new Wallet(accounts[1]!.secretKey);
  const contract = yield* attempt(() => new ContractFactory(artifact.abi, artifact.evm.bytecode.object, publisher).deploy());
  const deployment = yield* attempt(() => contract.deploymentTransaction()!.wait());
  if (!deployment || deployment.status !== 1) return yield* fail("Local contract deployment failed");
  const session: Session = { rpc, contract: yield* attempt(() => contract.getAddress()), publisher: publisher.address, otherPublisher: otherPublisher.address, original, modified, receipt: "0", web: `http://127.0.0.1:${webPort}` };
  yield* command([process.execPath, cli, "anchor", "--repo", repository, "--tag", "v0.2", "--artifact", original], sourceDirectory, { ...cliEnvironment(session), VMRL_PRIVATE_KEY: accounts[0]!.secretKey });
  // Prove the seeded receipt through the real CLI before declaring the demo ready.
  yield* check(session);
  yield* attempt(() => Bun.write(sessionFile, JSON.stringify(session, null, 2) + "\n"));
  yield* attempt(() => Bun.write(join(run, "publisher-address.txt"), publisher.address + "\n"));
  yield* attempt(() => Bun.write(join(run, "untrusted-address.txt"), otherPublisher.address + "\n"));
  if (signals.flag.value) return;

  const webDirectory = join(root, "packages/web");
  const requireModule = createRequire(join(webDirectory, "package.json"));
  const next = requireModule.resolve("next/dist/bin/next");
  const web = yield* Effect.acquireRelease(
    Effect.sync(() => Bun.spawn([process.execPath, next, "dev", "--hostname", "127.0.0.1", "--port", String(webPort)], {
      cwd: webDirectory,
      env: { ...process.env, VMRL_PRIVATE_KEY: "", VMRL_LOCAL_DEMO: "1", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_VMRL_LOCAL_DEMO: "1", NEXT_PUBLIC_VMRL_RPC_URL: rpc, NEXT_PUBLIC_VMRL_CHAIN_ID: String(chainId), NEXT_PUBLIC_VMRL_CONTRACT_ADDRESS: session.contract, NEXT_PUBLIC_VMRL_START_BLOCK: String(deployment.blockNumber), NEXT_PUBLIC_VMRL_DEMO_PUBLISHER: publisher.address, NEXT_PUBLIC_VMRL_DEMO_OTHER_PUBLISHER: otherPublisher.address, VMRL_DEMO_ARTIFACT_DIR: run },
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
    })),
    (child) => Effect.gen(function* () {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        yield* Effect.race(
          attempt(() => child.exited),
          Effect.sleep("5 seconds").pipe(Effect.tap(() => Effect.sync(() => { if (child.exitCode === null) child.kill("SIGKILL"); }))),
        );
      }
    }).pipe(Effect.catchAllCause(() => Effect.void)),
  );

  const deadline = Date.now() + 90000;
  let ready = false;
  while (!signals.flag.value && Date.now() < deadline) {
    if (web.exitCode !== null) return yield* fail(`Dashboard exited ${web.exitCode} before readiness`);
    ready = yield* attempt(() => fetch(session.web, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok).catch(() => false));
    if (ready) break;
    yield* Effect.sleep("250 millis");
  }
  if (signals.flag.value) return;
  if (!ready) return yield* fail("Dashboard did not become ready within 90 seconds");
  console.log(`\nVMRL LOCAL DEMO READY\nDashboard: ${session.web}\nOriginal:  ${original}\nModified:  ${modified}\nTrusted publisher:   ${publisher.address}\nUntrusted publisher: ${otherPublisher.address}\n\nOpen receipt #0, choose release.js, then enter the trusted publisher.\nReplace it with release-modified.js to show a digest mismatch.\nUse the untrusted address to show a separate publisher-policy failure.\nSecond terminal: bun run demo:check\nCtrl+C stops both services. Restarting creates a fresh chain and release.\nDevelopment wallets are public test identities: NEVER send real funds to them.\n`);
  if (!process.argv.includes("--no-open") && Bun.which("xdg-open")) {
    const opener = Bun.spawn(["xdg-open", session.web], { stdout: "ignore", stderr: "ignore" });
    void opener.exited;
  }
  yield* Effect.race(
    attempt(() => web.exited).pipe(
      Effect.flatMap((code) => Deferred.isDone(stopSignal).pipe(
        Effect.flatMap((done) => done ? Effect.void : fail(`Dashboard stopped unexpectedly (exit ${code})`)),
      )),
    ),
    Deferred.await(stopSignal),
  );
});

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "check") {
    if (!(yield* attempt(() => Bun.file(sessionFile).exists()))) return yield* fail("Start bun run demo in another terminal first");
    yield* check((yield* attempt(() => Bun.file(sessionFile).json())) as Session);
  } else if (args.length === 0 || (args.length === 1 && args[0] === "--no-open")) {
    yield* launch;
  } else {
    return yield* fail("Usage: bun run demo [--no-open] | bun run demo:check");
  }
});

Effect.runPromise(Effect.scoped(program)).catch((error: unknown) => {
  console.error(`Demo failed: ${errorText(error)}`);
  process.exitCode = 1;
});
