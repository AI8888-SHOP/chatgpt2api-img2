import {appConfig} from "./config.js";
import {hasFlag, readPositiveIntArg} from "./cli-args.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";
import {mkdir, readFile, writeFile, rm} from "node:fs/promises";
import path from "node:path";
import {spawn} from "node:child_process";

const TOKENS_FILE = path.resolve(process.cwd(), "hotmail", "tokens.txt");

async function runOnce(): Promise<void> {
    const directSignupAuth = hasFlag("--sign");
    const saveAccessToken = hasFlag("--at");
    const deviceProfile = generateRandomDeviceProfile();
    if (directSignupAuth) {
        const client = new OpenAIClient({
            password: appConfig.defaultPassword,
            deviceProfile,
            signupScreenHint: "signup",
        });
        const result = await client.authRegisterAndAuthorizeHTTP();
        console.log(`[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`);
        return;
    }
    if (saveAccessToken) {
        const registerClient = new OpenAIClient({
            password: appConfig.defaultPassword,
            deviceProfile,
        });
        await registerClient.authRegisterHTTP();
        const accessToken = await registerClient.getChatGPTAccessToken();
        const accessTokenFile = await registerClient.saveChatGPTAccessToken(accessToken);
        console.log(`[✅️注册成功] 邮箱：${registerClient.email} 密码：${appConfig.defaultPassword}`);
        console.log(`[access_token_file] ${accessTokenFile}`);
        console.log(`[access_token] ${accessToken}`);
        return;
    }
    const registerClient = new OpenAIClient({
        password: appConfig.defaultPassword,
        deviceProfile,
    });
    await registerClient.authRegisterHTTP();
    const loginClient = new OpenAIClient({
        email: registerClient.email,
        password: appConfig.defaultPassword,
        deviceProfile,
    });
    const result = await loginClient.authLoginHTTP();
    console.log(`[✅️授权成功] 邮箱：${loginClient.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`);
}

async function runLoop(maxRounds: number) {
    let round = 0, success = 0, fail = 0;
    while (!maxRounds || round < maxRounds) {
        round += 1;
        console.log(`第 ${round} 轮开始: 成功=${success} 失败=${fail} 模式=自动`);
        try {
            await runOnce();
            success += 1;
        } catch (error) {
            fail += 1;
            console.error(`[❌️授权失败]`, error);
        }
        if (appConfig.loopDelayMs > 0 && (!maxRounds || round < maxRounds)) {
            console.log(`[延迟] 轮次间等待 ${appConfig.loopDelayMs}ms`);
            await new Promise(r => setTimeout(r, appConfig.loopDelayMs));
        }
    }
    console.log(`自动模式结束: 已执行=${round} 成功=${success} 失败=${fail}`);
}

async function runMultiThread(threads: number, maxRounds: number) {
    const directSignupAuth = hasFlag("--sign");
    const saveAccessToken = hasFlag("--at");
    // Read all tokens
    let allLines: string[];
    try {
        allLines = (await readFile(TOKENS_FILE, "utf8")).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    } catch {
        console.error(`No tokens: ${TOKENS_FILE}`);
        return;
    }

    const perThread = Math.ceil(allLines.length / threads);
    const baseDir = path.resolve(process.cwd(), ".hotmail_threads");
    await rm(baseDir, {recursive: true, force: true});

    const children: Promise<void>[] = [];
    let started = 0;

    for (let i = 0; i < threads; i++) {
        const roundsForThread = Math.floor(maxRounds / threads) + (i < maxRounds % threads ? 1 : 0);
        if (roundsForThread === 0) break;
        const chunk = allLines.slice(i * perThread, (i + 1) * perThread);
        if (chunk.length === 0) break;

        const dir = path.join(baseDir, `thread_${i + 1}`);
        await mkdir(dir, {recursive: true});
        await writeFile(path.join(dir, "tokens.txt"), chunk.join("\n") + "\n", "utf8");

        console.log(`[线程 ${i + 1}] ${chunk.length} tokens, ${roundsForThread} rounds`);
        started++;

        children.push(new Promise<void>((resolve) => {
            const modeArgs = directSignupAuth ? ["--sign"] : saveAccessToken ? ["--at"] : [];
            const child = spawn(process.execPath, [
                process.argv[1], ...modeArgs, "--n", String(roundsForThread),
            ], {
                cwd: process.cwd(),
                env: {...process.env, HOTMAIL_DIR: dir},
                stdio: "inherit",
            });
            child.on("close", () => resolve());
        }));
    }

    console.log(`\n启动 ${started} 线程, 共 ${allLines.length} tokens\n`);
    await Promise.all(children);

    await rm(baseDir, {recursive: true, force: true});

    // Summary
    const tokenFile = path.resolve(process.cwd(), "auth", "access_tokens.txt");
    try {
        const count = (await readFile(tokenFile, "utf8")).split("\n").filter(Boolean).length;
        console.log(`\n========== 全部完成 ==========`);
        console.log(`总 access_token: ${count} 个 -> ${tokenFile}`);
    } catch {
        console.log(`\n========== 全部完成 ==========`);
    }
}

async function main() {
    const maxRounds = readPositiveIntArg("--n");
    const threads = readPositiveIntArg("--threads") || (appConfig as any).threads || 1;

    if (threads > 1 && maxRounds) {
        await runMultiThread(threads, maxRounds);
    } else {
        await runLoop(maxRounds || 0);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
