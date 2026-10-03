#!/usr/bin/env bash
# 兼容旧接口的薄包装
#
# 保留原 cfsm-return-route.sh 的调用约定：
#   cfsm-return-route.sh [region]  -> stdout 输出 JSON
#   退出码 0 = 至少一列有结论；2 = 三网全部无结论；其他 = 脚本异常
#
# 真正的探测与分类在 cfsm-return-route.py（同一份经过验证的逻辑，
# 避免用 shell/jq 重写一遍而产生行为漂移）。
set -u
set -o pipefail

exec /usr/bin/python3 /usr/local/bin/cfsm-return-route.py "${1:-浙江}"
