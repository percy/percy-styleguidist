import React from 'react';

/** A text input component. */
export default function Input({ placeholder }) {
  return <input className="input" placeholder={placeholder || 'Type here...'} />;
}
