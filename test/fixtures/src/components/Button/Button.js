import React from 'react';

/** A simple button component. */
export default function Button({ label, onClick }) {
  return <button className="btn" onClick={onClick}>{label || 'Click me'}</button>;
}
