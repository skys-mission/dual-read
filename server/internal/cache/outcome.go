package cache

// Outcome is the cache result status for X-Cache / metrics.
type Outcome string

const (
	OutcomeHIT       Outcome = "HIT"
	OutcomeMISS      Outcome = "MISS"
	OutcomeCOALESCED Outcome = "COALESCED"
	OutcomeBYPASS    Outcome = "BYPASS"
)

func (o Outcome) String() string {
	if o == "" {
		return string(OutcomeMISS)
	}
	return string(o)
}
