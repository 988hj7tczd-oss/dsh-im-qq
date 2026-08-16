#!/usr/bin/env bash
# 安装 dsh-im-qq 到 harness-desktop（home 级用户 patch 层）。
#
# 原理（与 dsh-computer-use 同模式，dsh profile-boot）：
#   patch 层顺序 = bundle → profile 层 → HOME 层（$DSH_HOME/cordis.patch.yml）→ --patch
#   我们在 HOME 层 insert 插件，不修改任何 profile 配置，卸载也干净。
#
# 凭据配置：
#   export DSH_QQ_APPID='你的AppID'      # 安装时写入 patch（否则写入空 id 占位）
#   export DSH_QQ_SECRET='你的AppSecret'  # 运行时由插件从环境变量读取（secretEnv 模式）
#   （GUI 应用不继承终端 export：用 launchctl setenv DSH_QQ_SECRET 'xxx' 或改配明文 secret）
#
# 用法: ./install.sh [--dry-run]    卸载: ./uninstall.sh
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

DSH_HOME="${DSH_HOME:-$HOME/Library/Application Support/harness-desktop/dsh-home}"
SRC="$(cd "$(dirname "$0")" && pwd)"
APPID="${DSH_QQ_APPID:-}"

echo "== dsh-im-qq install (home patch layer) =="
echo "  DSH_HOME: $DSH_HOME"
echo "  source  : $SRC"

# 1. 链接插件包到 profile 的 node_modules（加载器从 profile node_modules 解析插件名）
NM_DIR="$DSH_HOME/profiles/web/node_modules"
[ -d "$NM_DIR" ] || { echo "错误: 未找到 $NM_DIR"; exit 1; }
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] ln -sfn $SRC -> $NM_DIR/dsh-im-qq"
else
  ln -sfn "$SRC" "$NM_DIR/dsh-im-qq"
  echo "  [ok] 插件包已链接"
fi

# 1.5 插件目录内 node_modules → profile hoisted store（必需！与 dsh-computer-use 同模式）。
#     out-of-tree 插件（源码在 $DSH_HOME 之外、symlink 进 profile）按 Node 默认规则
#     从自身真实目录解析依赖；没有这个链接，@deepseek-ai/schemastery 等 import
#     在模块加载阶段就 ERR_MODULE_NOT_FOUND，dsh 引擎 fail-loud 启动即崩。
#     必须在写 patch（步骤 2）之前建立，避免运行中的引擎热加载时解析失败。
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] ln -sfn $DSH_HOME/profiles/node_modules -> $SRC/node_modules"
else
  ln -sfn "$DSH_HOME/profiles/node_modules" "$SRC/node_modules"
  echo "  [ok] 插件依赖链接已建立"
fi

# 2. 在 home 级 patch 层注册（幂等：已存在则跳过；已存在时若带 DSH_QQ_APPID 则回填 id）
PATCH="$DSH_HOME/cordis.patch.yml"
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] 写入 $PATCH : insert dsh-im-qq"
elif grep -q "dsh-im-qq" "$PATCH"; then
  echo "  [ok] $PATCH 已含 dsh-im-qq（跳过）"
  if [ -n "$APPID" ]; then
    # 回填真实 AppID（仅替换 dsh-im-qq 注册块内的空 id，避免误改其他插件行）
    python3 - "$PATCH" "$APPID" <<'PY'
import sys
p, appid = sys.argv[1], sys.argv[2]
s = open(p).read()
marker = '# dsh-im-qq 用户级注册'
start = s.find(marker)
if start >= 0:
    end = s.find('\n- insert:', start + len(marker))
    if end < 0:
        end = len(s)
    block = s[start:end]
    if "id: ''" in block:
        block = block.replace("id: ''", f"id: '{appid}'", 1)
        s = s[:start] + block + s[end:]
        open(p, 'w').write(s)
        print('  [ok] 已回填 AppID →', appid)
    else:
        print('  [skip] dsh-im-qq 块内无空 id 占位')
else:
    print('  [skip] 未找到 dsh-im-qq 注册块')
PY
  fi
else
  {
    printf '\n# dsh-im-qq 用户级注册（install.sh 生成）\n'
    printf -- '- insert:\n'
    printf '    - id: dsh-im-qq\n'
    printf '      name: dsh-im-qq\n'
    printf '      config:\n'
    if [ -n "$APPID" ]; then
      printf "        id: '$APPID'\n"
    else
      printf "        id: ''\n"
    fi
    printf "        secretEnv: 'DSH_QQ_SECRET'\n"
    printf '        sandbox: true\n'
    printf '        transport: websocket\n'
    printf '        provider: deepseek-official\n'
    printf '        model: deepseek-v4-flash\n'
    printf '        agentPreset: standard\n'
    printf "        cwd: '~/qq-workspace'\n"
    printf '        workspaceIsolation: true\n'
    printf "        allowFrom: ['*']\n"
    printf "        groupAllowFrom: ['*']\n"
    printf '        approval: true\n'
    printf '        slashCommands: true\n'
    printf '        debug: false\n'
  } >> "$PATCH"
  echo "  [ok] 已写入 $PATCH"
fi

# 3. 配置提示
if [ "$DRY_RUN" = 1 ]; then
  echo "== 预演完成（未写入任何文件）=="
else
  echo "== 安装完成，请确认凭据配置后重启 harness-desktop 生效 =="
  if [ -z "$APPID" ]; then
    echo "  ⚠️  未提供 AppID：请编辑 ${PATCH}，把 id 改成你的 AppID（加引号）"
  else
    echo "  [ok] AppID 已写入 → $APPID"
  fi
  echo "  AppSecret 二选一："
  echo "    方式A（推荐，不落盘）: launchctl setenv DSH_QQ_SECRET '你的AppSecret'"
  echo "    方式B（简单直接）  : 把 $PATCH 里的 secretEnv 行换成 secret: '你的AppSecret'"
fi
