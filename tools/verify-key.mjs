// 验证 DeepSeek 密钥：真调一次 API（绕过缓存），确认可用
// 用法: runtime\node.exe tools\verify-key.mjs
import { makeTranslator, loadSecrets } from "../lib/translate.mjs";

const secrets = loadSecrets();
const key = secrets.deepseekApiKey;

if (!key || !key.trim()) {
  console.log("  [X] 没读到 deepseekApiKey（密钥为空或文件格式有误）");
  console.log("      文件位置: .state/secrets.json");
  process.exit(2);
}

const masked = key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "（太短，可能不是有效 key）";
console.log(`  读到密钥: ${masked}  长度 ${key.length}`);
console.log(`  模型: ${secrets.deepseekModel || "deepseek-chat"}`);
console.log("  正在真实调用 DeepSeek API（绕过缓存）…");

const tr = makeTranslator({
  provider: "deepseek",
  useCache: false,                       // 验证必须真打 API，不能吃缓存
  log: (m) => console.log("  " + m),
});

const sample = "Invitation to take the Diagnostic English Language Tracking Assessment (DELTA). Please complete it before 30 September.";
const out = await tr.translate(sample);

if (!out) {
  console.log("  [X] 密钥验证失败（原因见上面的错误信息）");
  process.exit(3);
}

const st = tr.stats();
console.log(`  [OK] 密钥可用！（provider=${st.provider}）`);
console.log("  示例原文: " + sample.slice(0, 60) + "…");
console.log("  示例译文: " + out);
