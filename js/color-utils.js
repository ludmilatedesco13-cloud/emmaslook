const COLORES = {
    amarillo: '#e3c64b',
    azul: '#2878b8',
    'azul claro': '#8bbce0',
    'azul marino': '#263852',
    'azul oscuro': '#1e3a5f',
    'azul petroleo': '#236b73',
    beige: '#e8d9c5',
    blanco: '#fffdf8',
    'blanco roto': '#f5f0e7',
    bordo: '#782d43',
    camel: '#b78455',
    celeste: '#9dc7df',
    chocolate: '#76533f',
    coral: '#e98778',
    crema: '#f5ecd9',
    dorado: '#c8a05a',
    fucsia: '#cf3f83',
    gris: '#969696',
    'gris claro': '#d6d3cf',
    'gris oscuro': '#555555',
    lila: '#b99ac9',
    magenta: '#c83e7e',
    marron: '#76533f',
    mostaza: '#d4a638',
    naranja: '#e58b3f',
    negro: '#171615',
    nude: '#e8c7b5',
    oliva: '#74804a',
    plata: '#c4c6c8',
    rojo: '#c3423f',
    rosa: '#e7a9b5',
    'rosa viejo': '#bd858b',
    salmon: '#e78f7c',
    turquesa: '#40b6b2',
    verde: '#6f8e65',
    'verde agua': '#8ac8b5',
    'verde claro': '#9caf82',
    'verde militar': '#596347',
    violeta: '#79509a'
};

const COLOR_DESCONOCIDO = '#b7b2aa';

function normalizarNombreColor(color) {
    return String(color ?? '')
        .trim()
        .toLocaleLowerCase('es')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ');
}

function esColorClaro(hex) {
    const color = hex.length === 4
        ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
        : hex;
    const [red, green, blue] = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255);
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) > 0.72;
}

export function obtenerColorSwatch(color) {
    const nombre = normalizarNombreColor(color);
    const value = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(nombre)
        ? nombre
        : COLORES[nombre] || COLOR_DESCONOCIDO;
    return { value, light: esColorClaro(value) };
}
