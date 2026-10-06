import { useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import type { Position } from '@workspace/api-client-react';
import './ranked-position-input.css';

const ROLES: Position[] = ['Setter', 'Outside Hitter', 'Middle Blocker', 'Opposite', 'Libero'];
const slug = (p: string) => p.toLowerCase().replaceAll(' ', '-');

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export default function RankedPositionInput({ value, onChange }: { value: Position[]; onChange: (value: Position[]) => void }) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const pointerFrom = useRef<number | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  function toggle(p: Position) {
    onChange(value.includes(p) ? value.filter((v) => v !== p) : value.length >= 5 ? value : [...value, p]);
  }
  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = move(valueRef.current, from, to);
    if (next === valueRef.current) return;
    valueRef.current = next;
    onChange(next);
    setAnnounce(`${next[to]} moved to rank ${to + 1}`);
  }
  function cleanup() {
    pointerFrom.current = null;
    setDragIndex(null);
    setOverIndex(null);
  }
  function onPointerDown(e: RPointerEvent<HTMLButtonElement>, index: number) {
    if (e.pointerType === 'mouse') return; // desktop uses native drag
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerFrom.current = index;
    setDragIndex(index);
  }
  function onPointerMove(e: RPointerEvent<HTMLButtonElement>) {
    if (pointerFrom.current === null) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-rank-position]');
    if (!el) return;
    const target = valueRef.current.indexOf(el.dataset.rankPosition as Position);
    if (target < 0) return;
    if (target !== pointerFrom.current) {
      reorder(pointerFrom.current, target);
      pointerFrom.current = target;
      setDragIndex(target);
    }
    setOverIndex(target);
  }
  function endPointer(e: RPointerEvent<HTMLButtonElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    cleanup();
  }

  return (
    <div className="rpi" data-testid="ranked-position-input">
      <p className="rpi-help">Choose 3–5 unique roles, then order them. Rank 1 is your strongest.</p>
      <div className="position-options">
        {ROLES.map((p) => (
          <label className="position-option" key={p}>
            <input type="checkbox" checked={value.includes(p)} onChange={() => toggle(p)} data-testid={`checkbox-position-${slug(p)}`} />
            {p}
          </label>
        ))}
      </div>
      {value.length === 0 ? (
        <p className="rpi-empty">No roles chosen yet.</p>
      ) : (
        <ol className="rpi-list" aria-label="Ranked positions">
          {value.map((p, i) => (
            <li
              key={p}
              data-rank-position={p}
              data-testid={`rank-item-${slug(p)}`}
              className={`rpi-item${dragIndex === i ? ' dragging' : ''}${overIndex === i ? ' over' : ''}`}
              draggable
              onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p); setDragIndex(i); }}
              onDragOver={(e) => { e.preventDefault(); setOverIndex(i); }}
              onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) reorder(dragIndex, i); cleanup(); }}
              onDragEnd={cleanup}
            >
              <button
                type="button"
                className="rpi-handle"
                aria-label={`Drag ${p} to reorder`}
                data-testid={`handle-position-${slug(p)}`}
                onPointerDown={(e) => onPointerDown(e, i)}
                onPointerMove={onPointerMove}
                onPointerUp={endPointer}
                onPointerCancel={endPointer}
                onLostPointerCapture={cleanup}
              >::</button>
              <span className="rpi-rank">{i + 1}</span>
              <span>{p}</span>
              <span className="rpi-moves">
                <button type="button" className="rpi-move" disabled={i === 0} onClick={() => reorder(i, i - 1)} aria-label={`Move ${p} up`} data-testid={`button-move-up-${slug(p)}`}>Up</button>
                <button type="button" className="rpi-move" disabled={i === value.length - 1} onClick={() => reorder(i, i + 1)} aria-label={`Move ${p} down`} data-testid={`button-move-down-${slug(p)}`}>Down</button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="rpi-live" aria-live="polite">{announce}</div>
    </div>
  );
}
