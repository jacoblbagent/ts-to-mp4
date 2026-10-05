import { IconStar } from './icons';

export default function StarButton({ on, name, onClick }) {
  return (
    <button
      type="button"
      className={`star ${on ? 'on' : ''}`}
      aria-pressed={on}
      aria-label={on ? `Unfavorite ${name}` : `Favorite ${name}`}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
      onClick={onClick}
    >
      <IconStar filled={on} />
    </button>
  );
}
