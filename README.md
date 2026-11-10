# USTC 学术报告自动选课（多人通用版）

一个在每位用户各自电脑上运行的 Chrome / Edge Manifest V3 扩展，监控研究生综合服务平台中的“学术报告选课”。无需共享学校账号、浏览器 Cookie、SMTP 授权码或中央服务器。

## 功能

- 每 30 秒在后台查询一次，不需要一直打开报告页面。
- 地点关键词可由每位用户在扩展中修改，默认是“高新”。
- 只处理地点匹配且网站标记为**当前可选（SFKXK=1）**的未选报告。
- 首次运行也会处理列表中已经存在的符合条件报告。
- 默认是**演练模式**：只列出和通知匹配结果，不调用选课接口。
- 手动确认并开启“真实自动选课”后，才会提交选课。
- 每个报告最多共尝试 3 次，每次失败间隔 5 秒；成功或 3 次失败后发送浏览器通知。
- 同一报告不会重复提交；失败报告可在弹窗中手动重试。
- 选课成功后，通过本机邮件助手向当前用户配置的收件邮箱发送通知。
- 每位用户可配置不同的发件邮箱、收件邮箱和 SMTP 服务器。
- 邮件状态与选课状态分开记录；邮件失败可单独重发，不会再次提交选课。
- 登录失效时暂停监控并通知，不会保存或填写学校账号密码。

尚未开放的报告会等待网站将其标记为“可选”，不会提前调用提交接口，也不会因此消耗 3 次尝试。

## 每位用户的安装步骤

1. 将 `ustc-report-monitor` 文件夹复制到自己的电脑。
2. 打开 `chrome://extensions`（Edge 使用 `edge://extensions`）。
3. 打开“开发者模式”，点击“加载已解压的扩展程序”，选择该文件夹。
4. 打开并登录自己的研究生综合服务平台账号：
   <https://yjs1.ustc.edu.cn/gsapp/sys/yjsemaphome/portal/index.do?forceCas=1>
5. 在扩展的“通用设置”中修改地点关键词。
6. 按下一节配置自己的通知邮箱。
7. 先使用“演练模式”核对结果，再手动开启真实选课。

> 开启真实模式后，当前已存在以及之后新出现的所有符合条件报告都会被真实提交，不需要逐条确认。真实监控期间修改地点关键词也会要求再次确认。

## 配置个人通知邮箱（每人一次）

目前邮件助手的自动安装支持 **macOS**，使用 macOS 钥匙串和 `launchd`。

1. 获取发件邮箱的 **SMTP 授权码**。以 163 邮箱为例，可在邮箱设置的 POP3/SMTP/IMAP 页面开启 SMTP 并生成授权码。授权码不是邮箱登录密码。
2. 在终端进入本目录，运行：

   ```bash
   python3 email_helper.py --setup
   ```

3. 按提示输入发件邮箱、收件邮箱、SMTP 服务器和 SSL 端口。默认服务器为 `smtp.163.com`，默认端口为 `465`。
4. 输入该发件邮箱的 SMTP 授权码。输入不会回显，授权码只保存到当前用户的 **macOS 钥匙串**。

也可以通过参数提供非敏感配置，授权码仍采用隐藏输入：

```bash
python3 email_helper.py --setup \
  --sender sender@example.com \
  --recipient recipient@example.net \
  --smtp-host smtp.example.com \
  --smtp-port 465
```

助手会安装为当前用户的 `launchd` 服务，登录 Mac 后自动运行，不需要一直保留终端窗口。若授权码已存在，会沿用钥匙串中的授权码；需要更换时添加 `--reset-credential`。

如需验证配置，以下命令会**真实发送一封测试邮件**到当前配置的收件地址：

```bash
python3 email_helper.py --test
```

配置完成后，在 `chrome://extensions` 中重新加载扩展。扩展弹窗会显示当前的发件邮箱和收件邮箱。

## 多人使用时相互隔离

- 每个人使用自己的学校登录状态，扩展不会读取或保存学校账号密码。
- 每个人的 SMTP 授权码保存在自己的系统钥匙串中。
- 邮件配置和发送去重记录保存在各自电脑的本机 Application Support 目录。
- 报告状态、运行记录和设置保存在各自浏览器的 `chrome.storage.local`。
- 不要共享浏览器 Cookie、学校账号或 SMTP 授权码。

## 数据与权限

- 学校数据仅请求 `https://yjs1.ustc.edu.cn/*`。
- 邮件请求仅发送到本机 `http://127.0.0.1:17826/*`，再由本机助手连接用户配置的 SMTP 服务。
- 本地助手只接受浏览器扩展来源的请求，收件地址由本机配置决定，扩展不能任意更改。
- 除学校网站和用户明确配置的 SMTP 服务外，不向其他第三方服务发送数据。
- 使用 `alarms` 定时检查、`notifications` 发送结果通知、`storage` 保存状态。

## 当前网站接口

- 列表：`POST /gsapp/sys/xsbgglappustc/modules/xsbgxk/wxbgbgdz.do`
- 选课：`POST /gsapp/sys/xsbgglappustc/xsbgxkController/selectBg.do`
- 选课参数：表单字段 `data`，内容为 `{"BGBM":"报告编码"}`

接口依据 2026-11-10 的网站实现。如果学校调整接口或页面，扩展会显示错误；真实提交前应先重新使用演练模式验证。

## 测试

无需安装第三方依赖：

```bash
node --test tests/background.test.js tests/popup.test.js
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p '*_test.py' -v
```

测试使用模拟的网站响应、邮箱配置和模拟 SMTP，不会访问学校网站、真实选课或真实发送邮件。`PYTHONDONTWRITEBYTECODE=1` 用于避免生成 Chrome 不允许的 `__pycache__` 目录。
