#!/usr/bin/env bash
# Local smoke test for the Worker. Needs the mock and `wrangler dev` running (see README).
B=${B:-http://127.0.0.1:8787}
O="https://healthy-working-life-kirklees.github.io"
J='content-type: application/json'
ok=0; bad=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS  $1"; ok=$((ok+1)); else echo "FAIL  $1 (expected $2, got $3)"; bad=$((bad+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

check "health"                          200 "$(code $B/health)"
check "chat without Origin is refused"  403 "$(code -X POST $B/chat -H "$J" -d '{}')"
check "chat from wrong Origin refused"  403 "$(code -X POST $B/chat -H "Origin: https://evil.example" -H "$J" -d '{}')"
check "preflight from right Origin"     204 "$(code -X OPTIONS $B/chat -H "Origin: $O")"
check "unknown path"                    404 "$(code $B/nope -H "Origin: $O")"
check "bad JSON"                        400 "$(code -X POST $B/chat -H "Origin: $O" -H "$J" -d 'not json')"
check "empty message"                   400 "$(code -X POST $B/chat -H "Origin: $O" -H "$J" -d '{"messages":[{"role":"user","content":"  "}]}')"
check "assistant-last rejected"         400 "$(code -X POST $B/chat -H "Origin: $O" -H "$J" -d '{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]}')"
check "oversize body"                   413 "$(python3 -c "print('{\"x\":\"' + 'a'*70000 + '\"}')" | curl -s -o /dev/null -w '%{http_code}' -X POST $B/chat -H "Origin: $O" -H "$J" --data-binary @-)"

R=$(curl -s -X POST $B/chat -H "Origin: $O" -H "$J" -d '{"mode":"staff","messages":[{"role":"user","content":"I support someone anxious in Dewsbury"}]}')
check "unknown + duplicate ids dropped" "wellness-to-work,fitness-for-work" "$(echo "$R" | python3 -c 'import sys,json;print(",".join(r["id"] for r in json.load(sys.stdin)["recommendations"]))')"
check "CORS header on success"          "$O" "$(curl -s -D - -o /dev/null -X POST $B/chat -H "Origin: $O" -H "$J" -d '{"messages":[{"role":"user","content":"hi"}]}' | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')"

R=$(curl -s -X POST $B/chat -H "Origin: $O" -H "$J" -d '{"messages":[{"role":"user","content":"I am in crisis"}]}')
check "crisis: flag set, no cards"      "True,0" "$(echo "$R" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(str(d["safety_concern"])+","+str(len(d["recommendations"])))')"

if [ -f /tmp/last-request.json ]; then echo "upstream request seen by mock: $(cat /tmp/last-request.json)"; fi
echo "passed=$ok failed=$bad"; [ $bad -eq 0 ]
