/**
 * Paleta fija de emojis animados que se pueden mandar a la mesa. `id` es el código Unicode: así se llama su animación
 * en Noto Emoji Animation (Google). Solo viajan estos ids: nunca texto libre.
 * Archivo aparte y sin dependencias: la web lo importa sin cargar los esquemas del contrato.
 */
export const TABLE_EMOJIS = [
  { id: '1f602', char: '😂', label: 'Risa' },
  { id: '1f44f', char: '👏', label: 'Aplausos' },
  { id: '1f62e', char: '😮', label: 'Sorpresa' },
  { id: '1f621', char: '😡', label: 'Enojo' },
  { id: '1f60e', char: '😎', label: 'Canchero' },
  { id: '1f64f', char: '🙏', label: 'Por favor' },
  { id: '1f525', char: '🔥', label: 'Fuego' },
  { id: '1f4b8', char: '💸', label: 'Plata' },
  { id: '1f921', char: '🤡', label: 'Payaso' },
  { id: '1f62d', char: '😭', label: 'Llanto' },
  { id: '1f389', char: '🎉', label: 'Festejo' },
  { id: '1f44d', char: '👍', label: 'Bien' },
  { id: '1f648', char: '🙈', label: 'Mono' },
  { id: '1f3a3', char: '🎣', label: 'Pescador' },
  { id: '1f44a', char: '👊', label: 'Puño' },
] as const;

export type TableEmojiId = (typeof TABLE_EMOJIS)[number]['id'];
