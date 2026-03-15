// Line icons drawn on a 16px grid.

function Icon({ d }: { d: string }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const DownloadIcon = () => <Icon d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />;
export const RemoveIcon = () => <Icon d="M4 4l8 8M12 4l-8 8" />;
export const ChevronIcon = () => <Icon d="M4.5 6.5 8 10l3.5-3.5" />;
