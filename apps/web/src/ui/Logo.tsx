/** MeetPilot mark: a rounded square with a voice-wave and a spark (the assistant). */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="MeetPilot">
      <defs>
        <linearGradient id="mp-g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop stopColor="#3d8bff" /><stop offset="1" stopColor="#7b3ff2" /></linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#mp-g)" />
      <g stroke="#fff" strokeWidth="2.4" strokeLinecap="round"><path d="M8.5 13.5v5" /><path d="M13 10v12" /><path d="M17.5 12.5v7" /></g>
      <path d="M23.5 8.5l1.1 2.4 2.4 1.1-2.4 1.1-1.1 2.4-1.1-2.4-2.4-1.1 2.4-1.1z" fill="#fff" />
    </svg>
  );
}
