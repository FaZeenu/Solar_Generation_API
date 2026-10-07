# District generation summary

`GET /districts/:districtId/generation-summary` derives a summary from existing installations and readings; it stores no aggregate data and changes no schema.

Authentication is required. `analyst-read-by-district` plus a numeric `districtId` grants access to that district only; `hierarchy-admin` permits all districts. Existing JSON errors, content negotiation, private caching, representation ETags and conditional GET apply.

`currentTotalPowerKw` sums each installation's latest power reading at or before the request time, ordering by timestamp descending and ID descending for ties. Installations without readings contribute zero. This is last-known power, not a guarantee of live telemetry: oldest/latest source timestamps are included.

`todayTotalEnergyKwh` sums cumulative-energy increments between consecutive readings over today's Asia/Colombo (+05:30) calendar window. The calculation loads the last reading at/before midnight and today's samples through the request time. A crossing-midnight interval is prorated by elapsed time, assuming uniform energy accumulation within that interval. Negative counter differences contribute zero rather than subtracting generation; the first sample without a prior baseline contributes no inferred energy. Duplicate timestamps use the highest reading ID. The API does not extrapolate after the most recent sample or infer generation for missing samples. Coverage counts expose the availability of baseline and interval data; counter resets can undercount and require better source telemetry for exact accounting.

The response includes district ID/name/province ID, installation count, kW/kWh totals, coverage counts, Sri Lankan date and UTC day boundaries. Date and source-data context are provided instead of a volatile wall-clock field, allowing unchanged representations to retain stable ETags. The day end is exclusive. No Last-Modified date is invented.

The original seed covers January 1–7, 2026. On later dates its today's energy total is zero; its current power remains the last-known historical value, with the source timestamps showing that age.
