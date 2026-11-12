import React from "react";
export const paths = {
  overview: ["M3 12h4l3-7 4 14 3-7h4"],
  content: ["M5 3h10l4 4v14H5z", "M14 3v5h5", "M8 12h8M8 16h6"],
  storage: [
    "M4 6c0-4 16-4 16 0s-16 4-16 0Z",
    "M4 6v12c0 4 16 4 16 0V6",
    "M4 12c0 4 16 4 16 0",
  ],
  arrow: ["M5 12h14m-5-5 5 5-5 5"],
  external: ["M8 5H5v14h14v-3", "M12 4h8v8M20 4 10 14"],
  download: ["M12 3v12m-5-5 5 5 5-5", "M4 16v5h16v-5"],
  shield: ["M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z", "m8 12 3 3 5-6"],
  globe: [
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    "M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18",
  ],
  chevron: ["m8 5 7 7-7 7"],
  check: ["m5 12 4 4L19 6"],
  info: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", "M12 11v6M12 7v1"],
  refresh: ["M20 8a8 8 0 1 0 0 8", "M20 3v5h-5"],
  eye: [
    "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  ],
};
export default function Icon({ name, size = 20, ...props }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {(paths[name] || paths.info).map((d, i) => (
        <path d={d} key={i} />
      ))}
    </svg>
  );
}
