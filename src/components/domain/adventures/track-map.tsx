/**
 * A ride drawn as an outline (D182): the thinned track points projected
 * flat (fine at Singapore's scale), the checkpoints with their review
 * radius, start and finish marked. A picture for the reviewer, with no
 * map tiles: nothing about the ride leaves the Admin.
 */
type Point = { lat: number; lon: number };
type Checkpoint = {
  position: number;
  label: string;
  latitude: number | null;
  longitude: number | null;
  reviewRadiusM: number | null;
};

const WIDTH = 640;
const HEIGHT = 420;
const PAD = 24;

export function TrackMap({
  tracks,
  checkpoints,
  label,
}: {
  tracks: Point[][];
  checkpoints: Checkpoint[];
  label: string;
}) {
  const placed = checkpoints.filter(
    (c): c is Checkpoint & { latitude: number; longitude: number } =>
      c.latitude !== null && c.longitude !== null,
  );
  const all = [...tracks.flat(), ...placed.map((c) => ({ lat: c.latitude, lon: c.longitude }))];
  if (all.length === 0) {
    return <p className="text-sm text-dust-700">No positions to draw yet.</p>;
  }
  const midLat = (Math.min(...all.map((p) => p.lat)) + Math.max(...all.map((p) => p.lat))) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const xs = all.map((p) => p.lon * kx);
  const ys = all.map((p) => p.lat);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const span = Math.max(maxX - minX, maxY - minY, 1e-4);
  const scale = Math.min((WIDTH - 2 * PAD) / span, (HEIGHT - 2 * PAD) / span);
  const offX = (WIDTH - (maxX - minX) * scale) / 2;
  const offY = (HEIGHT - (maxY - minY) * scale) / 2;
  const at = (p: Point) => ({
    x: offX + (p.lon * kx - minX) * scale,
    y: HEIGHT - (offY + (p.lat - minY) * scale),
  });
  // Metres per degree of latitude, for the review radius circles.
  const pxPerMetre = scale / 111_195;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={label}
      className="h-auto w-full rounded-xl border border-hairline bg-paper"
    >
      {tracks.map((track, i) =>
        track.length > 1 ? (
          <polyline
            key={i}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            className="text-ink"
            points={track
              .map(at)
              .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
              .join(" ")}
          />
        ) : null,
      )}
      {tracks.map((track, i) => {
        if (track.length === 0) return null;
        const s = at(track[0]);
        const f = at(track[track.length - 1]);
        return (
          <g key={`ends-${i}`}>
            <circle cx={s.x} cy={s.y} r={6} className="fill-done-deep" />
            <rect x={f.x - 5} y={f.y - 5} width={10} height={10} className="fill-danger-deep" />
          </g>
        );
      })}
      {placed.map((c) => {
        const p = at({ lat: c.latitude, lon: c.longitude });
        const r = c.reviewRadiusM ? Math.max(6, c.reviewRadiusM * pxPerMetre) : 8;
        return (
          <g key={c.position}>
            <circle
              cx={p.x}
              cy={p.y}
              r={r}
              className="fill-info-soft stroke-info-deep"
              strokeWidth={1.5}
              fillOpacity={0.5}
            />
            <text x={p.x + r + 4} y={p.y + 4} className="fill-ink text-[13px] font-semibold">
              {c.position}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
