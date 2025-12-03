/**
 * =================================================================================
 * 项目: mymemory-2api (Cloudflare Worker 单文件版)
 * 版本: 2.0.0 (代号: Chimera Synthesis - Limit Breaker)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-04
 * 
 * [v2.0.0 核心升级]
 * 1. [突破限制] 自动生成随机虚拟邮箱 (de参数)，绕过 MyMemory 的匿名 IP 速率限制 (429错误)。
 * 2. [智能重试] 内置指数退避重试机制，遇到 429/5xx 错误自动轮换身份重试。
 * 3. [自动检测] 完美支持 "Autodetect|zh" 模式，自动识别源语言。
 * 4. [全能适配] 兼容 Cherry Studio、沉浸式翻译、NextChat 等所有 OpenAI 格式客户端。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "mymemory-2api",
  PROJECT_VERSION: "2.0.0",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  // 设置为 "1" 表示允许任何 Bearer Token 或无 Token 访问（方便测试）
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_URL: "https://api.mymemory.translated.net/get",
  
  // 伪装配置
  HEADERS: {
    "Referer": "https://dwz8.site/", // 伪装来源
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  },

  // 重试配置
  MAX_RETRIES: 3,
  RETRY_DELAY: 500, // 毫秒

  // 模型列表 (语言对)
  // 格式: "源语言|目标语言"
  MODELS: [
    "Autodetect|zh", // 自动检测 -> 中文 (默认)
    "en|zh",         // 英文 -> 中文
    "zh|en",         // 中文 -> 英文
    "ja|zh",         // 日文 -> 中文
    "zh|ja",         // 中文 -> 日文
    "ko|zh",         // 韩文 -> 中文
    "fr|zh",         // 法文 -> 中文
    "de|zh",         // 德文 -> 中文
    "ru|zh"          // 俄文 -> 中文
  ],
  DEFAULT_MODEL: "Autodetect|zh"
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    request.ctx = { apiKey };

    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. 路由分发
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑 (Translation Logic)] ---

class TranslationProvider {
  /**
   * 生成随机虚拟邮箱以绕过速率限制
   * MyMemory 允许通过提供邮箱来增加额度
   */
  static generateVirtualIdentity() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let user = '';
    for(let i=0; i<10; i++) user += chars[Math.floor(Math.random() * chars.length)];
    return `${user}@gmail.com`;
  }

  static async translate(text, model) {
    // 1. 解析语言对
    let langpair = "Autodetect|zh"; // 默认
    
    // 如果模型名包含 '|' (如 'en|zh')，直接使用
    if (model && model.includes('|')) {
      langpair = model;
    } 
    // 兼容性处理：如果客户端传的是 'gpt-3.5' 这种，强制回退到默认
    else if (!CONFIG.MODELS.includes(model)) {
      langpair = CONFIG.DEFAULT_MODEL;
    } else {
      langpair = model;
    }

    // 2. 执行带重试的请求
    let lastError = null;
    
    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        // 每次重试生成新的虚拟身份
        const virtualEmail = this.generateVirtualIdentity();
        
        const params = new URLSearchParams({
          q: text,
          langpair: langpair,
          de: virtualEmail, // 关键：注入邮箱参数
          mt: "1",          // 启用机器翻译
          onlyprivate: "0"
        });

        const url = `${CONFIG.UPSTREAM_URL}?${params.toString()}`;
        
        // 记录调试信息 (仅在开发环境或通过 UI 查看)
        // console.log(`Attempt ${attempt+1}: ${url}`);

        const response = await fetch(url, {
          method: "GET",
          headers: CONFIG.HEADERS
        });

        if (response.status === 429) {
          throw new Error("Rate Limit (429)");
        }

        if (!response.ok) {
          throw new Error(`Upstream Error: ${response.status}`);
        }

        const data = await response.json();

        // 校验业务状态码
        if (data.responseStatus !== 200) {
            // 403 通常也是额度问题
            if (data.responseStatus === 403) throw new Error("Quota Exceeded (403)");
            throw new Error(`API Error: ${data.responseDetails}`);
        }

        return {
            text: data.responseData.translatedText,
            match: data.responseData.match,
            usedEmail: virtualEmail // 返回使用的虚拟邮箱供调试
        };

      } catch (e) {
        lastError = e;
        // 如果是最后一次尝试，不再等待
        if (attempt < CONFIG.MAX_RETRIES) {
          // 指数退避等待
          await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError || new Error("Translation failed after retries");
  }
}

// --- [第四部分: API 接口处理] ---

async function handleApi(request) {
  if (!verifyAuth(request)) return createErrorResponse('未授权 (Unauthorized)', 401, 'unauthorized');

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return new Response(JSON.stringify({
      object: 'list',
      data: CONFIG.MODELS.map(id => ({ 
          id, 
          object: 'model', 
          created: Math.floor(Date.now()/1000), 
          owned_by: 'mymemory-2api' 
      }))
    }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  }

  if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  }

  return createErrorResponse('接口不存在', 404, 'not_found');
}

async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages.reverse().find(m => m.role === 'user');
    
    if (!lastMsg || !lastMsg.content) {
        throw new Error("未找到有效的用户消息内容");
    }

    const sourceText = lastMsg.content;
    const model = body.model || CONFIG.DEFAULT_MODEL;

    // 执行翻译
    const result = await TranslationProvider.translate(sourceText, model);
    const translatedText = result.text;

    // 构造响应
    if (body.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      
      (async () => {
        // 伪流式：模拟打字机效果
        const chunkSize = 4; // 每次发送4个字符，平衡速度和体验
        for (let i = 0; i < translatedText.length; i += chunkSize) {
            const chunkContent = translatedText.slice(i, i + chunkSize);
            const chunk = {
                id: requestId, 
                object: 'chat.completion.chunk', 
                created: Math.floor(Date.now()/1000),
                model: model, 
                choices: [{ index: 0, delta: { content: chunkContent }, finish_reason: null }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            await new Promise(r => setTimeout(r, 15)); // 15ms 延迟
        }
        
        const end = {
          id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000),
          model: model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(end)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      })();

      return new Response(readable, { headers: corsHeaders({ 'Content-Type': 'text/event-stream' }) });
    }

    // 非流式
    return new Response(JSON.stringify({
      id: requestId, 
      object: 'chat.completion', 
      created: Math.floor(Date.now()/1000),
      model: model, 
      choices: [{ 
          index: 0, 
          message: { role: 'assistant', content: translatedText }, 
          finish_reason: 'stop' 
      }],
      usage: {
          prompt_tokens: sourceText.length,
          completion_tokens: translatedText.length,
          total_tokens: sourceText.length + translatedText.length
      }
    }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- 辅助函数 ---

function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.apiKey;
  if (key === "1") return true; 
  return auth === `Bearer ${key}`;
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// --- [第五部分: 开发者驾驶舱 UI (WebUI)] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.apiKey;
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --accent: #007AFF; --success: #66BB6A; --error: #CF6679; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      
      .box { background: #252525; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
      .label { font-size: 12px; color: #888; margin-bottom: 8px; display: block; font-weight: 600; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 10px; border-radius: 4px; cursor: pointer; transition: background 0.2s; }
      .code-block:hover { background: #000; }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 10px; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box; font-family: inherit; }
      input:focus, textarea:focus, select:focus { border-color: var(--primary); outline: none; }
      
      button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; transition: opacity 0.2s; }
      button:hover { opacity: 0.9; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
      .msg { max-width: 85%; padding: 15px; border-radius: 8px; line-height: 1.6; position: relative; word-wrap: break-word; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; border-bottom-right-radius: 2px; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; border-bottom-left-radius: 2px; }
      
      .log-panel { height: 180px; background: #111; border-top: 1px solid var(--border); padding: 10px; font-family: monospace; font-size: 11px; color: #aaa; overflow-y: auto; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #222; padding-bottom: 2px; }
      .log-time { color: #666; margin-right: 5px; }
      .log-req { color: var(--accent); }
      .log-res { color: var(--success); }
      .log-err { color: var(--error); }

      details { margin-bottom: 15px; }
      summary { cursor: pointer; color: var(--text); font-weight: bold; margin-bottom: 10px; }
      .guide-content { background: #222; padding: 10px; border-radius: 4px; font-size: 12px; line-height: 1.5; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0; display:flex; align-items:center; gap:10px;">
            🌍 ${CONFIG.PROJECT_NAME} 
            <span style="font-size:12px;color:#888; font-weight:normal; margin-top:4px;">v${CONFIG.PROJECT_VERSION}</span>
        </h2>
        
        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">翻译模式 (Model)</span>
            <select id="model">
                ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            <div style="font-size:11px; color:#666; margin-top:-10px; margin-bottom:10px;">
                提示: "Autodetect|zh" 可自动识别源语言。
            </div>
            
            <span class="label">待翻译文本</span>
            <textarea id="prompt" rows="5" placeholder="输入需要翻译的内容...">Hello, who are you?</textarea>
            
            <button id="btn-gen" onclick="sendRequest()">🚀 开始翻译</button>
        </div>

        <details>
            <summary>🔌 客户端集成指南</summary>
            <div class="guide-content">
                <strong>Cherry Studio / NextChat 配置:</strong><br>
                API URL: <code>${origin}</code><br>
                API Key: <code>${apiKey}</code><br>
                模型: <code>Autodetect|zh</code><br>
                <br>
                <strong>沉浸式翻译 (OpenAI 格式):</strong><br>
                API URL: <code>${origin}/v1/chat/completions</code><br>
                API Key: <code>${apiKey}</code><br>
                模型: <code>Autodetect|zh</code>
            </div>
        </details>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:100px;">
                <div style="font-size:40px; margin-bottom:20px;">🈯</div>
                <h3>MyMemory 翻译代理就绪</h3>
                <p>已启用自动身份轮换，解决 429 限制。<br>支持流式输出，完美适配各类 AI 客户端。</p>
            </div>
        </div>
        <div class="log-panel" id="logs"></div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        
        function log(type, msg) {
            const el = document.getElementById('logs');
            const div = document.createElement('div');
            div.className = 'log-entry';
            const typeClass = type === 'REQ' ? 'log-req' : (type === 'ERR' ? 'log-err' : 'log-res');
            div.innerHTML = \`<span class="log-time">[\${new Date().toLocaleTimeString()}]</span> <span class="\${typeClass}">[\${type}]</span> \${msg}\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }

        function copy(text) {
            navigator.clipboard.writeText(text);
            const el = event.target;
            const originalBg = el.style.background;
            el.style.background = '#333';
            setTimeout(() => el.style.background = originalBg, 200);
        }

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerText = text;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function sendRequest() {
            const prompt = document.getElementById('prompt').value.trim();
            const model = document.getElementById('model').value;
            
            if (!prompt) return alert('请输入内容');

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerText = "翻译中...";

            if(document.querySelector('.chat-window').innerText.includes('翻译代理就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            appendMsg('user', prompt);
            const aiMsg = appendMsg('ai', '...');
            let fullText = '';
            const startTime = Date.now();

            log('REQ', \`发送翻译请求: "\${prompt.substring(0, 20)}..." (Model: \${model})\`);

            try {
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: 'user', content: prompt }],
                        stream: true
                    })
                });

                if (!res.ok) {
                    const errData = await res.json();
                    throw new Error(errData.error?.message || res.statusText);
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                aiMsg.innerText = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') break;
                            try {
                                const json = JSON.parse(dataStr);
                                const content = json.choices[0].delta.content;
                                if (content) {
                                    fullText += content;
                                    aiMsg.innerText = fullText;
                                }
                            } catch (e) {}
                        }
                    }
                }
                const duration = Date.now() - startTime;
                log('RES', \`翻译完成 (耗时: \${duration}ms)\`);

            } catch (e) {
                aiMsg.innerHTML = \`<span style="color:#CF6679">❌ 错误: \${e.message}</span>\`;
                log('ERR', e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = "开始翻译";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
