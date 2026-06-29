package main

import "testing"

func TestMachineName(t *testing.T) {
	cases := []struct{ dns, host, want string }{
		{"contabo-eur.taile1ef5e.ts.net.", "contabo", "contabo-eur"},
		{"do-fra-oomaipro.taile1ef5e.ts.net", "x", "do-fra-oomaipro"},
		{"", "fallbackhost", "fallbackhost"},
		{"single", "x", "single"},
	}
	for _, c := range cases {
		if got := machineName(c.dns, c.host); got != c.want {
			t.Errorf("machineName(%q,%q)=%q want %q", c.dns, c.host, got, c.want)
		}
	}
}
