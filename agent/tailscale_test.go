package main

import "testing"

func TestTailscaleDetection(t *testing.T) {
	running := []byte(`{"BackendState":"Running","Self":{"DNSName":"antpc.tail1234.ts.net.","CapMap":{"funnel":null,"https":null}}}`)
	if h := tsHost(running); h != "antpc.tail1234.ts.net" {
		t.Fatalf("host %q", h)
	}
	for _, s := range []string{`{"BackendState":"NeedsLogin","Self":{"DNSName":"x.ts.net."}}`, `{"BackendState":"Running","Self":{"DNSName":""}}`, `garbage`} {
		if h := tsHost([]byte(s)); h != "" {
			t.Fatalf("%s → %q, want nothing", s, h)
		}
	}
	host := "antpc.tail1234.ts.net"
	cases := []struct {
		serve string
		port  int
		reuse bool
	}{
		{``, 443, false},
		{`{}`, 443, false},
		// the user's own site already on 443: never overwrite it, use the next Funnel port
		{`{"TCP":{"443":{"HTTPS":true}},"Web":{"antpc.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}`, 8443, false},
		// already published by an earlier install: reuse it
		{`{"TCP":{"443":{"HTTPS":true},"8443":{"HTTPS":true}},"Web":{"antpc.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:19998"}}}}}`, 8443, true},
		{`{"TCP":{"443":{},"8443":{},"10000":{}}}`, 0, false},
	}
	for _, c := range cases {
		p, r := pickFunnelPort([]byte(c.serve), host)
		if p != c.port || r != c.reuse {
			t.Errorf("%s → %d/%v, want %d/%v", c.serve, p, r, c.port, c.reuse)
		}
	}
}

func TestFunnelLinkShownOnceAndWhole(t *testing.T) {
	var got []string
	w := &linkWatch{onLink: func(l string) { got = append(got, l) }}
	for _, part := range []string{"Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tails", "cale.com/f/funnel?node=nJCsvg", "cfb611CNTRL\n\n", "still waiting\nhttps://login.tailscale.com/other\n"} {
		w.Write([]byte(part))
	}
	if len(got) != 1 || got[0] != "https://login.tailscale.com/f/funnel?node=nJCsvgcfb611CNTRL" {
		t.Fatalf("got %q, want the whole link once", got)
	}
}
