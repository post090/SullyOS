#!/bin/sh
# Cloudflare Workers Builds 的构建命令。由 sync-workers-repo workflow 复制进
# 部署仓库的每个 worker 目录，CF 在 wrangler deploy 之前执行它。
#
# 存在的唯一理由：D1 的 database_id 是账号级的，没法预先写死在仓库里。以前只能让
# 用户去 GitHub 网页编辑器改一行——手机上很难受。改成读构建变量之后，用户在
# Cloudflare 面板填一个文本框就行（那个页面他本来就要去设密钥），GitHub 那边只剩
# Fork 和 Sync fork 两个按钮。
#
# 需要的构建变量（Settings → Build → Variables，普通变量即可，不是 secret，
# database_id 不是敏感信息）：
#   D1_DATABASE_ID   仅当该 worker 的 wrangler.toml 里还留着占位符时才需要
set -eu

PLACEHOLDER='REPLACE_WITH_YOUR_D1_ID'

# 只认「生效中」的占位符：注释行不算。instant-push 的 D1 是可选增强，它那份
# wrangler.toml 里整个 [[d1_databases]] 块是注释掉的、占位符也在注释里——按字面
# 匹配就会逼着不需要 D1 的用户去建库。
if ! grep -v '^[[:space:]]*#' wrangler.toml 2>/dev/null | grep -q "$PLACEHOLDER"; then
  # 这个 worker 不需要 D1（或用户已经把 id 直接提交进 fork 了），无事可做。
  echo "[deploy-prepare] 没有待填的 D1 占位符，跳过。"
  exit 0
fi

if [ -z "${D1_DATABASE_ID:-}" ]; then
  echo "[deploy-prepare] 这个 Worker 需要 D1，但构建变量 D1_DATABASE_ID 是空的。" >&2
  echo "" >&2
  echo "  怎么修：" >&2
  echo "    1. Cloudflare 面板 → Storage & Databases → D1 → 建一个库" >&2
  echo "    2. 进去复制它的 Database ID" >&2
  echo "    3. 回到本 Worker → Settings → Build → Variables" >&2
  echo "       加一个 D1_DATABASE_ID，值粘上去" >&2
  echo "    4. 重新跑一次部署" >&2
  exit 1
fi

# id 由 CF 生成，形如 8-4-4-4-12 的 uuid。先校验再替换：粘歪了（比如带上了
# 前后空格、或者复制成了库名）在这里报出来，比部署完发现绑定不对好排查。
if ! printf '%s' "$D1_DATABASE_ID" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
  echo "[deploy-prepare] D1_DATABASE_ID 看起来不像 Database ID：'$D1_DATABASE_ID'" >&2
  echo "  应该是一串 uuid（8-4-4-4-12 位十六进制），不是数据库的名字。" >&2
  exit 1
fi

# 走临时文件而不是 sed -i：BSD sed（macOS）的 -i 要带参数，GNU sed 不用，
# 这个写法两边都对——本地拿 macOS 试这个脚本时不会莫名其妙挂掉。
sed "s|$PLACEHOLDER|$D1_DATABASE_ID|" wrangler.toml > wrangler.toml.tmp
mv wrangler.toml.tmp wrangler.toml
echo "[deploy-prepare] 已把 D1 database_id 填进 wrangler.toml。"
