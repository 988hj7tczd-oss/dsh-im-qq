#!/usr/bin/env bash
# 卸载 dsh-im-qq（移除 home patch 层注册 + 插件链接）。
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/Library/Application Support/harness-desktop/dsh-home}"
PATCH="$DSH_HOME/cordis.patch.yml"
SRC="$(cd "$(dirname "$0")" && pwd)"

echo "== dsh-im-qq uninstall =="

if [ -f "$PATCH" ]; then
  python3 - "$PATCH" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p).read()
before = s
# 移除 install.sh 生成的块（从 '# dsh-im-qq 用户级注册' 到下一个顶层条目前）
s = re.sub(r'\n?# dsh-im-qq 用户级注册（install\.sh 生成）\n(?:- insert:\n(?:[ \t]+.*\n?)*)', '\n', s, count=1)
s = s.strip('\n') + '\n'
open(p, 'w').write(s)
print('  [ok] 已从', p, '移除注册块' if s != before else '（未找到注册块）')
PY
else
  echo "  [skip] 无 patch 文件"
fi

rm -f "$DSH_HOME/profiles/web/node_modules/dsh-im-qq"
rm -f "$SRC/node_modules" # 插件目录内依赖链接（install.sh 步骤 1.5 建立）
echo "== 卸载完成，请重启 harness-desktop 生效 =="
