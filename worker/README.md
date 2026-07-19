# Cloudflare Worker 邮件中转服务部署说明

为了在国内稳定地收发 Gmail、Outlook 等外网邮箱邮件，我们需要在 Cloudflare Workers 上部署一个中转代理服务。该服务使用 CF Worker 最新的 `cloudflare:sockets` TCP 能力，通过安全的 HTTPS 和密码验证与 Scripting 客户端进行交互。

## 部署步骤

### 方式一：使用 Wrangler 命令行部署（推荐）

如果你本地有 Node.js 环境，可以在终端中直接部署：

1. **进入 worker 目录**：
   ```bash
   cd "email tools/worker"
   ```

2. **安装依赖**：
   ```bash
   npm install
   ```

3. **登录 Cloudflare**：
   ```bash
   npx wrangler login
   ```

4. **部署服务**：
   ```bash
   npx wrangler deploy
   ```
   部署成功后，控制台会输出一个类似 `https://mail-proxy.<你的用户名>.workers.dev` 的地址。

5. **设置安全验证令牌 (AUTH_TOKEN)**：
   执行以下命令设置你的安全令牌，防止接口被他人滥用：
   ```bash
   npx wrangler secret put AUTH_TOKEN
   ```
   输入一个你自己设计的复杂随机字符串（例如：`MyMailSecretToken_2026`）。**记住此令牌，接下来需要在 Scripting App 的代理设置中填写它。**

---

### 方式二：在 Cloudflare 网页后台部署

如果你手头没有电脑或命令行环境，可直接在 Cloudflare 控制台操作：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 点击左侧导航栏的 **Workers & Pages**，然后点击 **Create Application** -> **Create Worker**。
3. 给 Worker 起个名字（例如 `mail-proxy`），点击 **Deploy**。
4. 部署后，点击 **Edit Code** 进入在线编辑器。
5. 将本项目中 `worker/index.ts` 的全部代码复制并粘贴覆盖在线编辑器中的代码。
6. 点击右上角的 **Save and Deploy** 按钮。
7. 返回 Worker 的控制面板，切换到 **Settings (设置)** -> **Variables (变量)**。
8. 在 **Environment Variables (环境变量)** 下点击 **Add variable**：
   - 变量名称：`AUTH_TOKEN`
   - 变量类型：选择 `Encrypt` (加密，即 Secret)
   - 变量值：输入你自己设计的复杂令牌字串（例如 `MyMailSecretToken_2026`）
9. 点击 **Save and deploy** 保存。

---

## 客户端配置

Worker 部署完毕后，打开 iOS 的 **Scripting** 应用程序：

1. 启动本 **邮件工具** 脚本。
2. 点击右上角的齿轮 ⚙️ 进入 **「代理设置」**：
   - **代理模式**：选择 `自动（国外邮箱走代理）` 或 `始终代理`。
   - **Worker 地址**：填写你在上面部署出来的 URL（如 `https://mail-proxy.xxx.workers.dev`，末尾不需要斜杠 `/`）。
   - **验证令牌**：填写在第 5 步中设置的 `AUTH_TOKEN`。
3. 点击 **保存设置**。
4. 接下来点击 **「添加邮箱账号」**，填写你的 Gmail/Outlook 并测试连接即可！
