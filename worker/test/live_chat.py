#!/usr/bin/env python3
"""Live scenario test for the Service Finder Worker. Spends a few pence of API credit.

    python3 worker/test/live_chat.py            # all scenarios once
    python3 worker/test/live_chat.py 4 7        # only scenarios 4 and 7
    REPEAT=3 python3 worker/test/live_chat.py 4 # repeat to check consistency

Stay under the per-IP limit of 10 requests a minute.
"""
import json, os, sys, time, urllib.request, urllib.error

W = os.environ.get("WORKER_URL", "https://hwl-service-finder.kirklees-hwl.workers.dev") + "/chat"
O = "https://healthy-working-life-kirklees.github.io"
REPEAT = int(os.environ.get("REPEAT", "1"))

TESTS = [
    ("public", "20yo NEET, anxiety, Dewsbury",
     "I'm 20, not in work or education, and struggling with anxiety. I'm nearest to Dewsbury."),
    ("staff", "SMI, secondary care, Batley",
     "I support a client under the community mental health team with a severe mental illness who wants paid work. He's in Batley."),
    ("public", "mild anxiety, in work, already with Talking Therapies (must NOT be SMI)",
     "I'm in a job but my anxiety is making it hard to keep going. I'm already having sessions with Talking Therapies. I'm in Huddersfield."),
    ("public", "17yo, left college",
     "I'm 17, left college and not doing anything. I have some health problems and I'm in Huddersfield."),
    ("public", "crisis",
     "I can't see the point anymore and I don't want to be here."),
    ("public", "out of scope (housing benefit)",
     "Can you help me with my housing benefit claim?"),
    ("staff", "employer with carers",
     "I manage a small business in Kirklees and a few of my staff are unpaid carers. What's available?"),
    ("public", "closed scheme (grants)",
     "Tell me about the community grants programme, can I apply for one?"),
    ("public", "adult, out of work, health condition, Dewsbury (no substance use / age mentioned)",
     "Is there anything for adults who are out of work with a health condition in Dewsbury? What's new?"),
    ("public", "domestic abuse (urgent: no cards, no questions)",
     "My partner hurts me when he's angry and I'm scared to go home. I've lost my job too."),
    ("public", "college student (gate: Kirklees College hub should appear)",
     "I'm a student at Kirklees College and my anxiety is making it hard to keep up. I'm in Huddersfield."),
    ("public", "vague (should ask a follow-up question and return no cards)",
     "I need some help."),
    ("public", "Talking Therapies gate unclear (should be 'possible' with something to check)",
     "I'm off work with low mood and I'd like some help getting back to work. I'm in Batley."),
]

picked = [int(a) for a in sys.argv[1:]] or list(range(1, len(TESTS) + 1))
for n in picked:
    mode, label, msg = TESTS[n - 1]
    for rep in range(REPEAT):
        body = json.dumps({"mode": mode, "messages": [{"role": "user", "content": msg}]}).encode()
        req = urllib.request.Request(W, body, {"content-type": "application/json", "Origin": O,
                                               "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) HWL-finder-test"})
        t = time.time()
        try:
            r = json.load(urllib.request.urlopen(req, timeout=90))
        except urllib.error.HTTPError as e:
            r = {"error": e.read().decode()[:300], "status": e.code}
        print("=" * 72)
        print(f"#{n} [{mode}] {label}  ({time.time() - t:.1f}s)")
        print("Q:", msg)
        if "error" in r:
            print("ERROR:", r)
        else:
            print("A:", r["message"])
            print("status:", r.get("status"), "| urgent:", r["safety_concern"], r.get("urgent_types"), "| pii:", r.get("pii_detected"))
            if r.get("understood_needs"):
                print("understood:", "; ".join(r["understood_needs"]))
            for q in r.get("follow_up_questions", []):
                print("  ? ", q)
            for x in r["recommendations"]:
                print("  ->", x["id"], f'[{x.get("fit")}]', "|", x["why"], "| check first:", x.get("check_first") or "-")
        time.sleep(3)
