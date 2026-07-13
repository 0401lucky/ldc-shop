export function Logo({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 32 32"
            fill="none"
            className={className}
            aria-hidden="true"
        >
            <g transform="translate(16 14.5)">
                <ellipse cx="0" cy="-6" rx="4" ry="5.2" fill="currentColor" fillOpacity="0.9" />
                <ellipse cx="6" cy="0" rx="5.2" ry="4" fill="currentColor" fillOpacity="0.75" />
                <ellipse cx="0" cy="6" rx="4" ry="5.2" fill="currentColor" fillOpacity="0.9" />
                <ellipse cx="-6" cy="0" rx="5.2" ry="4" fill="currentColor" fillOpacity="0.75" />
                <circle cx="0" cy="0" r="2" fill="currentColor" fillOpacity="0.35" />
            </g>
            <path
                d="M16 20c0 2.4.5 4.2 1.6 5.8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                fill="none"
                opacity="0.7"
            />
        </svg>
    )
}
