#!/usr/bin/env bash
# install-hooks.sh — .githooks/ を git のフックパスとして有効化する（ADR-011）
#
# ⚠️ core.hooksPath は **コミットされないローカル設定** のため、
#    clone / Codespaces 再作成 / 新しい環境のたびに実行が必要。
#    実行し忘れると **保護が無音で外れる**（pre-push が単に走らなくなるだけで、何も警告されない）。

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

[ -d .githooks ] || { echo "❌ .githooks/ が無い（リポジトリルートで実行しているか確認）" >&2; exit 1; }
chmod +x .githooks/* 2>/dev/null || true

CURRENT="$(git config --get core.hooksPath || true)"
if [ "$CURRENT" = ".githooks" ]; then
  echo "✅ core.hooksPath は既に .githooks（pre-push 有効）"
else
  git config core.hooksPath .githooks
  echo "✅ core.hooksPath=.githooks を設定（pre-push 有効化）"
  [ -n "$CURRENT" ] && echo "   ※ 以前の設定 '$CURRENT' を上書きしました"
fi

echo "   検査: ガード回帰 / シェル構文 / 秘密情報"
echo "   緊急回避: git push --no-verify（使用したら workspace の memory/decisions.md に記録）"
