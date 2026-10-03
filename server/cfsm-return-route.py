#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CFSM 三网回程探测 v3

替换对象：/usr/local/bin/cfsm-return-route.sh
调用方式：cfsm-return-route.py <region>            正常探测
          cfsm-return-route.py --selftest <file>   用抓好的 trace 复算（离线验证）

设计要点见 README.md。核心相对旧版的变化：
  A. 用 nexttrace -j 的结构化输出，不再 grep 彩色文本
  B. 信号源优先级 ASN 号 > IP 段 > geo/owner 文本（文本会误判：AS58453 与 AS58807 的 isp 都写作「中移国际」）
  C. 位置感知：剔除「目的 AS 的尾部跳」后再取证据
  D. 置信度门控：置信度衡量「结论的证据强度」，不是「路径完整度」。
     证据段出现本运营商骨干标签（59.43 / 219.158 / 223.120 …）就是硬事实，直接 high；
     负向结论（普通国际，即「没看到」）一律 low——骨干跳不响应 ICMP 是常态，
     一次采样没命中说明不了线路变了。更新器据此区别对待：high 立即翻转，
     low 要求「连续多次同向」才翻转（见 cfsm-route-update.sh 的 CFSM_FLIP_CONFIRM）。
  E. CN2 用 59.43 / 202.97 IP 段判定，可选区分 GIA / GT
  F. 三网并发探测，最坏耗时从 165s 降到 55s
  G. 国内路径识别：全程落在境内的机器（如阿里云杭州）不存在「国际回程」，
     输出「国内电信 / 国内联通 / 国内移动」，避免给出字面错误的「普通国际」
"""
import ipaddress
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

NEXTTRACE = "/usr/local/bin/nexttrace"
PROBE_TIMEOUT = 55          # 单次 trace 上限（秒）
SPLIT_CN2 = False           # False：CN2 一律输出 CN2GIA，值域与旧版一致，主题无需改
                            # True ：额外区分 CN2GT。注意实测单次采样不足以判定
                            #        GIA/GT（VMISS 两次采样一次 GT 一次 GIA），
                            #        开启前应先要求「连续多次采样一致」
RETRY_ON_LOW = True         # 低置信时重探一次并合并证据
                            # 骨干中间跳不响应是随机的，采样两次可显著补齐证据

REGION_PREFIX = {"浙江": "zj", "上海": "sh", "北京": "bj", "广东": "gd"}
CARRIERS = (("telecom", "ct"), ("unicom", "cu"), ("mobile", "cm"))
CARRIER_LABEL = {"telecom": "电信", "unicom": "联通", "mobile": "移动"}

PREFIX_TAGS = [(ipaddress.ip_network(n), t) for n, t in [
    ("59.43.0.0/16", "CN2"),
    ("202.97.0.0/16", "163"),
    ("218.105.0.0/16", "9929"),
    ("219.158.0.0/16", "4837"),
    ("43.255.170.0/24", "10099"),
    ("162.219.0.0/16", "10099"),
    ("223.120.0.0/16", "58453"),
    ("221.183.0.0/16", "9808"),
    ("211.136.0.0/13", "9808"),
]]

TEXT_TAGS = [
    (r"中国电信/CN2|CN2", "CN2"),
    (r"CNC-BACKBONE|CUII", "9929"),
    (r"chinaunicomglobal|CUG-BACKBONE", "10099"),
    (r"CU169-BACKBONE|CHINA169", "4837"),
    (r"CMI ?N2", "58807"),
    (r"中移国际|CMI", "58453"),
    (r"CMNET|China Mobile|中国移动", "9808"),
]

ASN_TO_TAG = {
    4134: "163", 4809: "CN2", 136190: "CT",
    4837: "4837", 9929: "9929", 10099: "10099",
    9808: "9808", 56041: "CMCC", 58807: "58807", 58453: "58453",
}
CN_ASNS = set(ASN_TO_TAG)
CN_BACKBONE_TAGS = {"CN2", "163", "9929", "4837", "10099", "58807", "9808", "58453"}

# 各运营商的「正向决定性证据」标签：证据段里出现其一，本次结论就建立在一条
# 硬事实上（具体 IP 段或 ASN 号），而不是建立在「没看到」这种弱证据上。
#
# telecom 收 163（202.97/AS4134 就是电信 163 骨干，看到它就能确认「电信但非 CN2」，
# 这正是「普通国际」这个值要表达的语义）；unicom 收 4837（219.158/AS4837 是中国
# 联通 169 骨干）；mobile 收 9808（221.183/211.136 是移动 CMNET）。
DECISIVE_TAGS = {
    "telecom": ("CN2", "163"),
    "unicom": ("9929", "10099", "4837"),
    "mobile": ("58807", "58453", "9808"),
}


def log(msg):
    sys.stderr.write("[cfsm] %s\n" % msg)


def run_probe(host):
    """跑一次 nexttrace -j，返回 (ok, obj, err)"""
    cmd = [NEXTTRACE, "-4", "--tcp", "-p", "80", "-q", "3",
           "--psize", "1400", "--max-hops", "22", "-j", host]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=PROBE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return False, None, "timeout>%ss" % PROBE_TIMEOUT
    except Exception as exc:
        return False, None, "spawn_failed:%s" % exc

    out = (p.stdout or "").strip()
    start = out.find("{")
    if p.returncode != 0 or start < 0:
        return False, None, "exit=%s no_json" % p.returncode
    try:
        return True, json.JSONDecoder().raw_decode(out[start:])[0], ""
    except Exception as exc:
        return False, None, "bad_json:%s" % exc


def build_hops(obj):
    hops = []
    for group in (obj or {}).get("Hops") or []:
        if not isinstance(group, list) or not group:
            continue
        f = group[0]
        geo = f.get("Geo") or {}
        addr = (f.get("Address") or {}).get("IP") or ""
        asn_raw = str(geo.get("asnumber") or "").strip()
        asn = int(asn_raw) if asn_raw.isdigit() else None
        isp = (geo.get("isp") or "").strip()
        owner = (geo.get("owner") or "").strip()
        ok = bool(f.get("Success")) and bool(addr) and addr != "null"

        asn_tag = ASN_TO_TAG.get(asn)
        prefix_tag = None
        if ok and addr:
            try:
                ipobj = ipaddress.ip_address(addr)
                for net, tag in PREFIX_TAGS:
                    if ipobj in net:
                        prefix_tag = tag
                        break
            except ValueError:
                pass
        text_tag = None
        blob = "%s %s" % (isp, owner)
        for pat, tag in TEXT_TAGS:
            if re.search(pat, blob):
                text_tag = tag
                break

        tag = asn_tag or prefix_tag or text_tag
        hops.append({
            "ttl": f.get("TTL"), "ip": addr, "asn": asn, "isp": isp,
            "country": (geo.get("country") or "").strip(),
            "ok": ok, "tag": tag,
            "src": "asn" if asn_tag else ("prefix" if prefix_tag else ("text" if text_tag else "")),
        })
    return hops


def _hop_score(h):
    """合并两次采样时用来挑「信息更全」的那条跳。

    同一 TTL 两次都解析成功时，旧实现保留先到的那条，可能留下一个
    country/asn 全空的残次观测，把国内路径判据的占比算坏。
    """
    return (1 if h["ok"] else 0,
            1 if h["country"] else 0,
            1 if h["asn"] is not None else 0,
            1 if h["tag"] else 0)


def merge_hop_lists(a, b):
    """按 TTL 合并两次探测的跳表，同一 TTL 取信息量最大的那条。

    骨干中间跳是否响应具有随机性，两次采样的并集通常比任何单次都完整。
    """
    by_ttl = {}
    for h in a + b:
        cur = by_ttl.get(h["ttl"])
        if cur is None or _hop_score(h) > _hop_score(cur):
            by_ttl[h["ttl"]] = h
    return [by_ttl[t] for t in sorted(by_ttl)]


def _retry_worthwhile(carrier, ev):
    """是否值得再探一次并合并证据。

    重探的收益是补齐「随机不响应的中间跳」，两种情况收益明确：
      1. 路径没看全（analyse 给出的路径完整度置信度为 low）：重探有机会补齐骨干跳；
      2. 证据段里同时出现本运营商的多档标签（如联通同时看到 9929 与 10099）：
         两次采样的并集更全，高档标签不会因单次采样抖动而丢失，避免在档位
         之间来回翻转。

    注意这里用的是 analyse 给出的「路径完整度」置信度，还没有经过 _decisive
    的升级——重探与否应该由「证据够不够」决定，而不是由「结论有多硬」决定。
    国内路径已由「无境外跳」结构性确认，重探不会带来新信息，直接跳过。
    """
    if ev.get("domestic"):
        return False
    if ev["confidence"] == "low":
        return True
    return len(set(DECISIVE_TAGS[carrier]) & ev["ev_tags"]) >= 2


def probe_carrier(carrier, host, fallback=None):
    """探测单个运营商，低置信或无结论时尝试备选目标重探并合并；返回 (ev, err)"""
    ok, obj, err = run_probe(host)
    hops = build_hops(obj) if ok else []
    ev = analyse(hops) if hops else None

    # 如果初次探测失败，或者结果证据不足需要重探
    if RETRY_ON_LOW and (ev is None or _retry_worthwhile(carrier, ev)):
        target2 = fallback if (fallback and (ev is None or not ev.get("decisive"))) else host
        ok2, obj2, err2 = run_probe(target2)
        if ok2:
            hops2 = build_hops(obj2)
            if not hops:
                ev = analyse(hops2)
                if ev is not None:
                    ev["retried"] = True
            else:
                merged = merge_hop_lists(hops, hops2)
                ev2 = analyse(merged)
                if ev2 is not None:
                    ev = ev2
                    ev["retried"] = True

    if ev is None:
        return None, err or "no_resolved_hop"
    return ev, ""


def _is_private(ip):
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False


def public_hops_of(hops):
    """已解析成功、且不是内网地址的跳"""
    return [h for h in hops if h["ok"] and h["ip"] and not _is_private(h["ip"])]


def is_domestic_path(public_hops):
    """判断路径是否完全位于中国境内。

    国内机（阿里云杭州这类）到浙江三网走的是省内路径，不存在国际回程；
    词表里的 CN2GIA / 9929 / CMIN2 / 普通国际 是为国际线路设计的，
    套用在国内路径上会得出「普通国际」这种字面错误的结论。

    判定条件（同时满足）：
      1. 至少有一个已解析的公网跳；
      2. 没有任何一跳的国家明确落在境外；
      3. 中国跳 >= 2 个，且占已解析公网跳的半数以上。

    条件 3 用「数量 + 占比」而不是「前两跳」，是因为实测阿里云的首跳
    常常拿不到 geo（形如 11.73.6.238，国家字段为空），只认前两跳会漏判。
    条件 3 同时挡住两类误判：
      - 海外机：前段是美/日，要么被条件 2 拦下，要么境外跳占多数使占比不达标；
      - 只有目的跳带 geo 的残缺采样：中国跳只有 1 个，不满足 >= 2。

    目的跳（探测目标本身，浙江三网 zstatic 节点）定义上就在国内，按已知
    事实计入中国跳——它的 geo 偶尔拿不到，不能因此少算一个。
    """
    if not public_hops:
        return False
    if has_foreign_hop(public_hops):
        return False
    cn = sum(1 for h in public_hops if h["country"] in ("中国", "China"))
    # 最后一个公网跳就是探测目标（目标 IP 是公网地址），按已知事实补计
    if public_hops[-1]["country"] not in ("中国", "China"):
        cn += 1
    return cn >= 2 and cn * 2 >= len(public_hops)


def has_foreign_hop(public_hops):
    """路径中是否出现明确落在境外的跳"""
    return any(h["country"] and h["country"] not in ("中国", "China")
               for h in public_hops)


def analyse(hops):
    resolved = [h for h in hops if h["ok"]]
    if not resolved:
        return None
    max_ttl = max(h["ttl"] for h in hops)
    un = {h["ttl"] for h in hops if not h["ok"]}

    longest_run = run = 0
    for t in sorted(h["ttl"] for h in hops):
        if t in un:
            run += 1
            longest_run = max(longest_run, run)
        else:
            run = 0

    dest_asn = resolved[-1]["asn"]
    public_hops = public_hops_of(resolved)
    cn_hops = [h for h in resolved
               if h["country"] == "中国" or h["asn"] in CN_ASNS
               or h["tag"] in CN_BACKBONE_TAGS]

    # 位置感知：剔除尾部属于「目的 AS」的跳，避免测试目标自身污染判据
    tail_cut = 0
    if dest_asn is not None:
        for h in reversed(resolved):
            if h["asn"] == dest_asn and h["ttl"] >= max_ttl - 3:
                tail_cut += 1
            else:
                break
    tail_ttls = {h["ttl"] for h in resolved[-tail_cut:]} if tail_cut else set()
    evidence = [h for h in cn_hops if h["ttl"] not in tail_ttls]

    ev_tags = {h["tag"] for h in evidence if h["tag"]}
    cn_tags = {h["tag"] for h in cn_hops if h["tag"]}

    # 路径完整度：只用来决定「要不要再探一次」，不再当作最终置信度。
    # 骨干中间跳不响应是常态（实测 12 条 trace 有 10 条最长连续未响应 >= 3 跳），
    # 所以这个 low 只表示「这条路径没看全，值得再采一次」。
    # 最终置信度由 classify 显式给出：正向证据 / 国内路径 -> high，其余 -> low。
    path_incomplete = longest_run >= 3
    weak = path_incomplete or not evidence

    return {
        "max_ttl": max_ttl, "unresolved": sorted(un), "longest_run": longest_run,
        "dest_ip": resolved[-1]["ip"], "dest_asn": dest_asn,
        "cn_hops": cn_hops, "evidence": evidence, "tail_cut": tail_cut,
        "ev_tags": ev_tags, "cn_tags": cn_tags,
        "public_hops": public_hops,
        "first_public": public_hops[0] if public_hops else None,
        "domestic": is_domestic_path(public_hops),
        "no_foreign": not has_foreign_hop(public_hops),
        "cn_count": sum(1 for h in public_hops
                        if h["country"] in ("中国", "China")),
        "path_incomplete": path_incomplete,
        "confidence": "low" if weak else "high",
    }


def _negative(ev, value, why, note=""):
    """负向结论（没看到本运营商的骨干证据）统一降到 low 置信度。

    「没看到」是弱证据：骨干跳不响应 ICMP 是常态，一次采样没命中不代表线路
    真的变了。所以负向结论一律 low，由更新器要求「连续多次同向」才翻转。

    这条规则是被实测逼出来的：解冻后第一次上线，QQG 移动列在 23 秒内从 CMI
    翻成了「普通国际」（前一次采样看到了 AS9808，后一次两次采样都没看到），
    两个结论都拿到了 high，更新器照规则翻转了。负向结论必须比正向结论更难
    生效，否则面板会在档位之间来回跳。

    例外：如果 _decisive 已经命中（证据段里有本运营商的骨干跳），那这个「负向」
    取值其实建立在硬事实上——电信看到 163 跳就是「电信 163 骨干」的直接证据，
    只是词表里 163 对应的值恰好叫「普通国际」。这种情况保持 high。
    """
    if not ev.get("decisive"):
        ev["confidence"] = "low"
        ev.pop("conf_reason", None)
    return value, why, note


def _decisive(ev, carrier):
    """正向结论的置信度判定：证据段出现本运营商的骨干标签 -> 直接 high。

    置信度要回答的是「这个结论可复现吗」，而不是「路径完整吗」。
    骨干中间跳不响应是常态（实测 12 条 trace 有 10 条最长连续未响应 >= 3 跳），
    拿它当置信度会让绝大多数列永远停在 low，从而被更新器 conf=="high" 的
    翻转门控永久冻结——线路真的变了也不会更新。

    59.43 就是 CN2、219.158 就是 4837、223.120 就是 CMIN2，这些是硬事实，
    不会因为别的跳没响应而变得不确定。所以只要证据段里出现本运营商的骨干标签，
    本次结论就建立在硬证据上，给 high。

    反过来，「没看到」是弱证据：可能只是这次采样没命中。所以负向结论不走这里，
    而是统一由 _negative 降到 low，交给更新器的「连续多次同向」机制把关。

    返回是否命中；命中时写回 ev["confidence"]、ev["decisive"] 与 ev["conf_reason"]。
    """
    hit = sorted(set(DECISIVE_TAGS[carrier]) & ev["ev_tags"])
    if hit:
        ev["confidence"] = "high"
        ev["decisive"] = True
        ev["conf_reason"] = "正向证据 %s" % "/".join(hit)
    return bool(hit)


def classify(carrier, ev):
    """返回 (值, 依据, 备注)；值 None 表示本次无有效结论"""
    # 国内路径优先判定：这是一次结构性确认（全程无境外跳 + 首跳在境内），
    # 不受骨干中间跳是否响应影响，因此直接给高置信度。
    # 若沿用国际线路那套置信度规则，更新器会因为「未响应跳多」而拒绝改值，
    # 结果就是永远停在旧的字面错误值「普通国际」上。
    if ev.get("domestic"):
        ev["confidence"] = "high"
        first = ev["first_public"]
        return ("国内%s" % CARRIER_LABEL[carrier],
                "全程位于中国境内（首跳 %s %s，已解析公网跳 %d 个，无国际出口）"
                % (first["ip"], first["country"] or "?", len(ev["public_hops"])),
                "")

    # 失败保险：路径里看不到任何境外跳，却又不满足国内路径判据，且已经能看到
    # 中国跳（多半是 geo 采样残缺导致占比不达标）。这时给出「普通国际」是危险的
    # ——国内机可能因此被写成国际线路。宁可不下结论，让更新器保留旧值。
    #
    # 只在 cn_count >= 1 时启用：若整条路径的国家字段全空（geo 整体故障），
    # 说明是数据源问题而非路径问题，此时按 ASN 正常分类即可。
    if ev.get("no_foreign") and ev["cn_count"] >= 1 and not ev.get("domestic"):
        ev["confidence"] = "low"
        return None, ("未见境外跳但中国侧证据不足（已解析公网跳 %d 个，其中中国 %d 个）"
                      % (len(ev["public_hops"]), ev["cn_count"])), \
               "本次不更新该列，保留旧值"

    t, cn = ev["ev_tags"], ev["cn_tags"]

    # 正向证据优先：证据段里看到了本运营商的骨干跳，本次结论就落在硬事实上，
    # 不受「别的跳没响应」影响。放在分支之前，让下面各分支只管取值、不管置信度。
    _decisive(ev, carrier)

    if carrier == "telecom":
        if "CN2" in cn:
            n_cn2 = sum(1 for h in ev["cn_hops"] if h["tag"] == "CN2")
            n_163 = sum(1 for h in ev["cn_hops"] if h["tag"] == "163")
            detail = "CN2 跳 %d 个 / 163 段 %d 个" % (n_cn2, n_163)
            return "CN2", detail + "（不推断 GIA/GT）", ""
        return _negative(ev, "普通国际", "无 59.43/AS4809，按 163 处理")

    if carrier == "unicom":
        for tag, val in (("9929", "9929"), ("10099", "10099"), ("4837", "4837")):
            if tag in t:
                return val, "证据段含 %s（尾部剔除 %d 跳）" % (tag, ev["tail_cut"]), ""
        if "4837" in cn:
            return _negative(ev, "普通国际", "4837 仅存在于目的尾部，国际段非联通")
        return _negative(ev, "普通国际", "证据段无联通骨干")

    if carrier == "mobile":
        if "58807" in t:
            return "CMIN2", "证据段含 AS58807", ""
        if "58453" in t:
            return "CMI", "证据段含 AS58453（中国移动国际）", ""
        if "9808" in t:
            return "CMNET", "证据段含 AS9808（国内骨干；不推断 CMI）", ""
        if ev["confidence"] == "low":
            return _negative(ev, None, "中国侧证据不足，最长未响应 %d 跳"
                             % ev["longest_run"], "本次不更新该列，保留旧值")
        return _negative(ev, "普通国际", "证据段无移动骨干")

    return _negative(ev, "普通国际", "未覆盖")


def classify_offline(blocks):
    """离线复算：blocks 为 {carrier_key: raw_text}"""
    out = {}
    for key, _ in CARRIERS:
        raw = blocks.get(_)
        hops = build_hops(json.JSONDecoder().raw_decode(raw[raw.find("{"):])[0]) \
            if raw and "{" in raw else []
        ev = analyse(hops)
        if ev is None:
            out[key] = {"value": None, "confidence": "low",
                        "reason": "探测失败", "note": "本次不更新，保留旧值"}
            continue
        val, why, note = classify(key, ev)
        out[key] = {"value": val, "confidence": ev["confidence"],
                    "reason": why, "note": note,
                    "conf_reason": ev.get("conf_reason", ""),
                    "path_incomplete": ev["path_incomplete"],
                    "longest_unresolved_run": ev["longest_run"]}
    return out


def main():
    args = sys.argv[1:]
    if args and args[0] == "--selftest":
        text = open(args[1], encoding="utf-8", errors="replace").read()
        parts = re.split(r"===CARRIER:(\w+)===", text)
        blocks = {parts[i]: parts[i + 1] for i in range(1, len(parts) - 1, 2)}
        print(json.dumps(classify_offline(blocks), ensure_ascii=False, indent=2))
        return 0

    region = args[0] if args else "浙江"
    prefix = REGION_PREFIX.get(region, "zj")
    targets = {
        "telecom": "%s-ct-v4.ip.zstaticcdn.com" % prefix,
        "unicom": "%s-cu-v4.ip.zstaticcdn.com" % prefix,
        "mobile": "%s-cm-v4.ip.zstaticcdn.com" % prefix,
    }
    # 备选目标容灾：避免单一 CDN 目标遭运营商防火墙丢包时整列陷入无结论（stale）
    fallbacks = {
        "telecom": "183.131.7.1",
        "unicom": "60.12.0.1",
        "mobile": "218.205.68.11",
    } if prefix == "zj" else {}

    started = time.time()
    results, target_ips, retried = {}, {}, []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(probe_carrier, key, host, fallbacks.get(key)): key
                   for key, host in targets.items()}
        for fut in futures:
            key = futures[fut]
            ev, err = fut.result()
            if ev is None:
                log("%s probe failed (%s)" % (CARRIER_LABEL[key], err))
                results[key] = None
                continue
            if ev.get("retried"):
                retried.append(key)
                log("%s 证据不足或有档位歧义，已重探并合并证据" % CARRIER_LABEL[key])
            target_ips[key] = ev["dest_ip"]
            results[key] = (classify(key, ev), ev)

    payload = {
        "region": region,
        "probed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "elapsed_s": round(time.time() - started, 1),
        "method": "nexttrace-json-v2",
        "target_ips": target_ips,
        "retried": retried,
        "confidence": {},
        "reason": {},
    }
    usable = 0
    for key, _ in CARRIERS:
        r = results.get(key)
        if not r:
            payload[key] = "未知"
            payload["confidence"][key] = "low"
            payload["reason"][key] = "探测失败"
            continue
        (val, why, note), ev = r
        payload[key] = val if val else "未知"
        payload["confidence"][key] = ev["confidence"]
        parts = [why]
        # 无结论时 note 不拼进去：更新器自己会写成「保留旧值（本次无结论：…）」，
        # 再拼一遍「本次不更新该列，保留旧值」就重复了。
        if val and note:
            parts.append(note)
        if ev.get("conf_reason"):
            parts.append(ev["conf_reason"])
        elif val and ev["confidence"] == "low":
            # 有值却是低置信：只有「负向结论 + 路径没看全」这一种情形，
            # 需要在依据里说清楚为什么不敢翻转。
            parts.append("路径未看全（最长未响应 %d 跳）" % ev["longest_run"])
        payload["reason"][key] = "；".join(parts)
        if val:
            usable += 1

    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    for key, _ in CARRIERS:
        if payload["confidence"].get(key) == "low":
            log("%s 低置信：%s" % (CARRIER_LABEL[key], payload["reason"][key]))

    # exit 0 = 至少一列有结论（更新器逐列合并）
    # exit 2 = 全部无结论（更新器整份保留旧缓存）
    return 0 if usable else 2


if __name__ == "__main__":
    sys.exit(main())
