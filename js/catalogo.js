import { setProductImage } from './image-utils.js';
import { normalizarFotosProducto } from './product-photos.js';

let productosCatalogo = [];
let variantesPorProducto = new Map();
let productoSeleccionado = null;
let fotosModalActuales = [];
let indiceFotoModal = 0;
const productosFavoritos = new Set();
const dropdownsFiltros = [];

const money = value => Number(value || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

async function cargarCatalogoPublico() {
    try {
        await window.asegurarTablaVariantes();
        await window.asegurarColumnaFotosVariantes();
        const [productosRes, variantesRes, categoriasRes] = await Promise.all([
            window.executeNeonQuery("SELECT * FROM productos ORDER BY id DESC"),
            window.executeNeonQuery("SELECT * FROM producto_variantes ORDER BY producto_id, talle, color"),
            window.executeNeonQuery("SELECT * FROM categorias ORDER BY nombre")
        ]);

        productosCatalogo = productosRes || [];
        variantesPorProducto = new Map();
        (variantesRes || []).forEach(variant => {
            const key = String(variant.producto_id);
            if (!variantesPorProducto.has(key)) variantesPorProducto.set(key, []);
            variantesPorProducto.get(key).push(variant);
        });

        poblarFiltrosCategorias(categoriasRes || []);
        poblarFiltrosTalles();
        poblarFiltrosColores();
        inicializarDropdownsFiltros();
        renderizarGrilla(productosCatalogo);
    } catch (error) {
        console.error("Error al cargar el catálogo:", error);
        document.getElementById('grilla-productos').innerHTML = '<p style="text-align:center; color:#A95C42;">No se pudo cargar el catálogo en este momento.</p>';
    }
}

function obtenerVariantes(producto) {
    const variantes = variantesPorProducto.get(String(producto.id)) || [
        { talle: producto.talle || '', color: producto.color || '', stock: Number(producto.stock || 0) }
    ];
    const agrupadas = new Map();
    variantes.forEach(variant => {
        const talle = variant.talle || '';
        const color = variant.color || '';
        const key = `${talle}\u0000${color}`;
        const actual = agrupadas.get(key);
        if (actual) actual.stock += Number(variant.stock || 0);
        else agrupadas.set(key, { articulo: variant.articulo || '', talle, color, stock: Number(variant.stock || 0) });
    });
    return [...agrupadas.values()];
}

function poblarFiltrosCategorias(categorias) {
    const select = document.getElementById('filtro-categoria');
    categorias.forEach(cat => {
        select.add(new Option(cat.nombre, cat.nombre));
    });
}

function poblarFiltrosTalles() {
    const select = document.getElementById('filtro-talle');
    const tallesUnicos = [...new Set(productosCatalogo.flatMap(producto => obtenerVariantes(producto).map(variant => variant.talle).filter(Boolean)))];
    tallesUnicos.forEach(talle => {
        select.add(new Option(talle, talle));
    });
}

function poblarFiltrosColores() {
    const select = document.getElementById('filtro-color');
    const coloresUnicos = [...new Set(productosCatalogo.flatMap(producto => obtenerVariantes(producto).map(variant => variant.color).filter(Boolean)))];
    coloresUnicos.forEach(color => {
        select.add(new Option(color, color));
    });
}

function inicializarDropdownsFiltros() {
    ['categoria', 'talle', 'color'].forEach(tipo => {
        const select = document.getElementById(`filtro-${tipo}`);
        const dropdown = document.querySelector(`.filter-dropdown[data-filter="${tipo}"]`);
        const trigger = dropdown.querySelector('.filter-trigger');
        const label = dropdown.querySelector('.filter-trigger-label');
        const menu = dropdown.querySelector('.filter-menu');

        const actualizarOpciones = () => {
            menu.replaceChildren();
            Array.from(select.options).forEach(option => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'filter-option';
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', String(option.value === select.value));
                item.dataset.value = option.value;
                item.textContent = option.textContent;
                item.addEventListener('click', () => {
                    select.value = option.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    cerrarDropdown(false);
                });
                menu.appendChild(item);
            });
        };

        const cerrarDropdown = devolverFoco => {
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            if (devolverFoco) trigger.focus();
        };

        trigger.addEventListener('click', () => {
            const abrir = trigger.getAttribute('aria-expanded') !== 'true';
            dropdownsFiltros.forEach(otro => otro.close());
            menu.hidden = !abrir;
            trigger.setAttribute('aria-expanded', String(abrir));
        });
        select.addEventListener('change', () => {
            label.textContent = select.selectedOptions[0]?.textContent || '';
            menu.querySelectorAll('.filter-option').forEach(item => {
                item.setAttribute('aria-selected', String(item.dataset.value === select.value));
            });
        });
        menu.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                cerrarDropdown(true);
            }
        });
        actualizarOpciones();
        dropdownsFiltros.push({ close: () => cerrarDropdown(false) });
    });

    document.addEventListener('click', event => {
        if (!event.target.closest('.filter-dropdown')) dropdownsFiltros.forEach(dropdown => dropdown.close());
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') dropdownsFiltros.forEach(dropdown => dropdown.close());
    });
}

function obtenerFotosProducto(producto) {
    return normalizarFotosProducto(producto.fotos_variantes);
}

function obtenerFotoPorColor(producto, color) {
    const fotos = obtenerFotosProducto(producto);
    const colorBuscado = String(color || '').trim().toLocaleLowerCase();
    return fotos.find(foto => foto.color.toLocaleLowerCase() === colorBuscado)?.image
        || fotos[0]?.image
        || producto.foto_url;
}

function obtenerFotosGaleria(producto) {
    const fotos = obtenerFotosProducto(producto);
    const imagenesUnicas = fotos.filter((foto, index) =>
        fotos.findIndex(otra => otra.image === foto.image) === index
    );
    if (!imagenesUnicas.length && producto.foto_url) {
        return [{ color: producto.color || '', image: producto.foto_url }];
    }
    return imagenesUnicas;
}

function renderizarGrilla(productos) {
    const grilla = document.getElementById('grilla-productos');
    if (!productos.length) {
        grilla.innerHTML = '<p class="empty-catalog">No encontramos prendas con esos filtros. Probá con otra búsqueda.</p>';
        return;
    }

    grilla.innerHTML = productos.map(p => {
        const variantes = obtenerVariantes(p);
        const fotos = obtenerFotosGaleria(p);
        const stockTotal = variantes.reduce((total, variant) => total + Number(variant.stock || 0), 0);
        const colores = [...new Set(variantes.map(variant => variant.color).filter(Boolean))];
        const sinStock = stockTotal <= 0;
        return `
            <div class="product-card" data-id="${escapeHtml(p.id)}">
                <div class="product-img-container">
                    <img class="product-img" alt="${escapeHtml(p.nombre)}" />
                    ${fotos.length > 1 ? `
                        <button type="button" class="product-photo-arrow product-photo-previous" data-direction="-1" aria-label="Foto anterior de ${escapeHtml(p.nombre)}">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
                        </button>
                        <span class="product-photo-count" aria-live="polite">1 / ${fotos.length}${fotos[0].color ? ` · ${escapeHtml(fotos[0].color)}` : ''}</span>
                        <button type="button" class="product-photo-arrow product-photo-next" data-direction="1" aria-label="Foto siguiente de ${escapeHtml(p.nombre)}">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
                        </button>
                    ` : ''}
                    <button type="button" class="product-favorite" data-id="${escapeHtml(p.id)}" aria-label="${productosFavoritos.has(String(p.id)) ? 'Quitar de favoritos' : 'Agregar a favoritos'}: ${escapeHtml(p.nombre)}" aria-pressed="${productosFavoritos.has(String(p.id))}">${productosFavoritos.has(String(p.id)) ? '♥' : '♡'}</button>
                    <span class="product-stock-badge${sinStock ? ' is-out' : ''}">${sinStock ? 'Sin stock' : `${stockTotal} disponibles`}</span>
                </div>
                <div class="product-info">
                    <span class="product-cat">${escapeHtml(p.categoria || 'Emma’s Look')}</span>
                    <h3>${escapeHtml(p.nombre || 'Prenda')}</h3>
                    <p class="product-price">$${money(p.precio_venta)}</p>
                    <div class="product-swatches" aria-label="${colores.length ? `Colores: ${escapeHtml(colores.join(', '))}` : 'Sin colores especificados'}">
                        ${colores.slice(0, 6).map(color => {
                            const swatch = obtenerColorSwatch(color);
                            return `<button type="button" class="color-swatch${swatch.light ? ' is-light' : ''}" data-color="${escapeHtml(color)}" aria-label="Ver foto color ${escapeHtml(color)}" title="${escapeHtml(color)}" style="background-color:${swatch.value}"></button>`;
                        }).join('')}
                    </div>
                    <button type="button" class="btn-ver-detalle" data-id="${escapeHtml(p.id)}">Ver opciones</button>
                </div>
            </div>
        `;
    }).join('');

    productos.forEach(p => {
        const card = Array.from(grilla.querySelectorAll('.product-card')).find(item => item.dataset.id === String(p.id));
        const image = card?.querySelector('.product-img');
        const foto = obtenerFotosGaleria(p)[0];
        if (image) setProductImage(image, foto?.image, p.foto_url);
        if (image && foto?.color) image.alt = `${p.nombre} color ${foto.color}`;
    });
}

function obtenerColorSwatch(color) {
    const nombre = String(color).trim().toLowerCase();
    const colores = {
        beige: '#e8d9c5',
        blanco: '#fffdf8',
        'blanco roto': '#f5f0e7',
        bordo: '#782d43',
        bordó: '#782d43',
        camel: '#b78455',
        celeste: '#9dc7df',
        gris: '#969696',
        lila: '#b99ac9',
        marron: '#76533f',
        marrón: '#76533f',
        mostaza: '#d4a638',
        negro: '#171615',
        nude: '#e8c7b5',
        plata: '#c4c6c8',
        rojo: '#c3423f',
        rosa: '#e7a9b5',
        salmon: '#e78f7c',
        salmón: '#e78f7c',
        verde: '#6f8e65',
        violeta: '#79509a'
    };
    const value = colores[nombre] || (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(nombre) ? nombre : '#cbb89f');
    return { value, light: ['#fffdf8', '#f5f0e7', '#e8d9c5', '#e8c7b5', '#c4c6c8'].includes(value) };
}

function abrirModalProducto(productoId, colorSeleccionado = '') {
    productoSeleccionado = productosCatalogo.find(p => String(p.id) === String(productoId));
    if (!productoSeleccionado) return;

    document.getElementById('modal-nombre').textContent = productoSeleccionado.nombre;
    document.getElementById('modal-precio').textContent = `$${money(productoSeleccionado.precio_venta)}`;
    document.getElementById('modal-descripcion').textContent = productoSeleccionado.caracteristicas || productoSeleccionado.descripcion || 'Sin descripción adicional.';
    document.getElementById('modal-articulo').textContent = String(productoSeleccionado.articulo || productoSeleccionado.id);
    const selectVariante = document.getElementById('select-variante');
    const variantes = obtenerVariantes(productoSeleccionado);
    selectVariante.replaceChildren();
    variantes.forEach((variant, index) => {
        const stock = Number(variant.stock || 0);
        const disponibilidad = stock > 0 ? `Stock: ${stock} u.` : 'Sin stock';
        const option = new Option(
            `Talle ${variant.talle || '-'} · ${variant.color || '-'} — ${disponibilidad}`,
            String(index)
        );
        option.disabled = stock <= 0;
        selectVariante.add(option);
    });
    const primeraDisponible = variantes.findIndex(variant => Number(variant.stock) > 0);
    const varianteColor = variantes.findIndex(variant =>
        (!colorSeleccionado || String(variant.color).toLocaleLowerCase() === colorSeleccionado.toLocaleLowerCase())
        && Number(variant.stock) > 0
    );
    if (varianteColor >= 0) selectVariante.value = String(varianteColor);
    else if (primeraDisponible >= 0) selectVariante.value = String(primeraDisponible);
    actualizarDisponibilidadVariante();

    document.getElementById('modal-pedido').style.display = 'flex';
}

function actualizarDisponibilidadVariante() {
    if (!productoSeleccionado) return;
    const select = document.getElementById('select-variante');
    const button = document.getElementById('btn-enviar-whatsapp');
    const stockText = document.getElementById('modal-stock-variante');
    const variant = obtenerVariantes(productoSeleccionado)[Number(select.value)];
    const stock = Number(variant?.stock || 0);
    document.getElementById('modal-articulo').textContent = String(variant?.articulo || productoSeleccionado.id);
    actualizarGaleriaModal(variant?.color || '');
    stockText.textContent = variant
        ? (stock > 0 ? `Disponible: ${stock} unidad(es).` : 'Esta variante no tiene stock.')
        : 'No hay variantes disponibles.';
    button.disabled = !variant || stock <= 0;
    button.textContent = button.disabled ? 'Sin stock disponible' : '💬 Encargar por WhatsApp';
}

function actualizarGaleriaModal(color) {
    if (!productoSeleccionado) return;
    const galeria = document.getElementById('modal-galeria-fotos');
    const fotos = obtenerFotosGaleria(productoSeleccionado);
    const colorBuscado = String(color || '').trim().toLocaleLowerCase();
    fotosModalActuales = fotos.length ? fotos : [{ color: '', image: productoSeleccionado.foto_url || '' }];
    const indiceColor = fotosModalActuales.findIndex(foto => foto.color.toLocaleLowerCase() === colorBuscado);
    indiceFotoModal = indiceColor >= 0 ? indiceColor : 0;
    galeria.replaceChildren();
    fotosModalActuales.forEach((foto, index) => {
        const miniatura = document.createElement('button');
        miniatura.type = 'button';
        miniatura.className = 'modal-photo-thumb';
        miniatura.setAttribute('aria-label', `Ver foto ${index + 1}${foto.color ? ` color ${foto.color}` : ''}`);
        miniatura.setAttribute('aria-pressed', String(index === indiceFotoModal));
        const miniaturaImg = document.createElement('img');
        miniaturaImg.src = foto.image;
        miniaturaImg.alt = '';
        miniatura.appendChild(miniaturaImg);
        miniatura.addEventListener('click', () => actualizarFotoModal(index));
        galeria.appendChild(miniatura);
    });
    galeria.hidden = fotosModalActuales.length <= 1;
    actualizarFotoModal(indiceFotoModal);
}

function actualizarFotoModal(indice) {
    if (!productoSeleccionado || !fotosModalActuales.length) return;
    indiceFotoModal = (indice + fotosModalActuales.length) % fotosModalActuales.length;
    const foto = fotosModalActuales[indiceFotoModal];
    const imagen = document.getElementById('modal-img');
    setProductImage(imagen, foto.image, productoSeleccionado.foto_url);
    imagen.alt = foto.color ? `${productoSeleccionado.nombre} color ${foto.color}` : productoSeleccionado.nombre;
    const controlesVisibles = fotosModalActuales.length > 1;
    const contador = document.getElementById('modal-contador-fotos');
    contador.textContent = `${indiceFotoModal + 1} / ${fotosModalActuales.length}${foto.color ? ` · ${foto.color}` : ''}`;
    contador.hidden = !controlesVisibles;
    document.getElementById('modal-foto-anterior').hidden = !controlesVisibles;
    document.getElementById('modal-foto-siguiente').hidden = !controlesVisibles;
    document.querySelectorAll('.modal-photo-thumb').forEach((thumb, thumbIndex) => {
        thumb.setAttribute('aria-pressed', String(thumbIndex === indiceFotoModal));
    });
}

function enviarPedidoWhatsApp() {
    if (!productoSeleccionado) return;

    const variante = obtenerVariantes(productoSeleccionado)[Number(document.getElementById('select-variante').value)];
    if (!variante || Number(variante.stock) <= 0) return;
    const telefonoNegocio = "5493487726161"; // número de teléfono, emma's look

    const mensaje = `¡Hola! Vi el catálogo web de *Emma's Look* y quiero encargar esta prenda:\n\n` +
                    ` *${productoSeleccionado.nombre}*\n` +
                    ` Talle: ${variante.talle || 'Único'}\n` +
                    ` Color: ${variante.color || 'Único'}\n` +
                    ` Precio: $${money(productoSeleccionado.precio_venta)}\n\n` +
                    ` Tenés 10% de descuento abonando en efectivo.\n\n` +
                    `¿Me confirmás disponibilidad para coordinar la entrega? Gracias!`;

    const urlWhatsApp = `https://wa.me/${telefonoNegocio}?text=${encodeURIComponent(mensaje)}`;
    window.open(urlWhatsApp, '_blank');
}

function aplicarFiltros() {
    const texto = document.getElementById('busqueda-prenda').value.toLowerCase();
    const categoria = document.getElementById('filtro-categoria').value;
    const talle = document.getElementById('filtro-talle').value;
    const color = document.getElementById('filtro-color').value;

    const filtrados = productosCatalogo.filter(p => {
        const coincideTexto = String(p.nombre || '').toLowerCase().includes(texto);
        const coincideCat = !categoria || p.categoria === categoria;
        const variantes = obtenerVariantes(p);
        const coincideVariante = variantes.some(variant =>
            (!talle || variant.talle === talle) && (!color || variant.color === color)
        );

        return coincideTexto && coincideCat && coincideVariante;
    });

    renderizarGrilla(filtrados);
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

document.addEventListener('DOMContentLoaded', () => {
    cargarCatalogoPublico();

    document.getElementById('busqueda-prenda').addEventListener('input', aplicarFiltros);
    document.getElementById('filtro-categoria').addEventListener('change', aplicarFiltros);
    document.getElementById('filtro-talle').addEventListener('change', aplicarFiltros);
    document.getElementById('filtro-color').addEventListener('change', aplicarFiltros);
    document.getElementById('select-variante').addEventListener('change', actualizarDisponibilidadVariante);

    document.getElementById('grilla-productos').addEventListener('click', e => {
        const flechaFoto = e.target.closest('.product-photo-arrow');
        if (flechaFoto) {
            const card = flechaFoto.closest('.product-card');
            const product = productosCatalogo.find(item => String(item.id) === card?.dataset.id);
            if (!card || !product) return;
            const fotos = obtenerFotosGaleria(product);
            if (fotos.length < 2) return;
            const image = card.querySelector('.product-img');
            const indiceActual = Number(card.dataset.photoIndex || 0);
            const indiceNuevo = (indiceActual + Number(flechaFoto.dataset.direction) + fotos.length) % fotos.length;
            const foto = fotos[indiceNuevo];
            card.dataset.photoIndex = String(indiceNuevo);
            setProductImage(image, foto.image, product.foto_url);
            image.alt = foto.color ? `${product.nombre} color ${foto.color}` : product.nombre;
            card.querySelector('.product-photo-count').textContent = `${indiceNuevo + 1} / ${fotos.length}${foto.color ? ` · ${foto.color}` : ''}`;
            return;
        }

        const swatch = e.target.closest('.color-swatch');
        if (swatch) {
            const card = swatch.closest('.product-card');
            const product = productosCatalogo.find(item => String(item.id) === card?.dataset.id);
            const image = card?.querySelector('.product-img');
            if (product && image) {
                const fotos = obtenerFotosGaleria(product);
                const color = swatch.dataset.color;
                const indice = fotos.findIndex(foto => foto.color.toLocaleLowerCase() === color.toLocaleLowerCase());
                const indiceNuevo = indice >= 0 ? indice : 0;
                const foto = fotos[indiceNuevo];
                card.dataset.photoIndex = String(indiceNuevo);
                setProductImage(image, foto?.image || obtenerFotoPorColor(product, color), product.foto_url);
                image.alt = foto?.color ? `${product.nombre} color ${foto.color}` : product.nombre;
                const contador = card.querySelector('.product-photo-count');
                if (contador) contador.textContent = `${indiceNuevo + 1} / ${fotos.length}${foto?.color ? ` · ${foto.color}` : ''}`;
            }
            return;
        }

        const favorito = e.target.closest('.product-favorite');
        if (favorito) {
            const id = String(favorito.dataset.id);
            if (productosFavoritos.has(id)) productosFavoritos.delete(id);
            else productosFavoritos.add(id);
            const activo = productosFavoritos.has(id);
            favorito.setAttribute('aria-pressed', String(activo));
            favorito.setAttribute('aria-label', `${activo ? 'Quitar de favoritos' : 'Agregar a favoritos'}: ${favorito.closest('.product-card').querySelector('h3').textContent}`);
            favorito.textContent = activo ? '♥' : '♡';
            return;
        }

        const btn = e.target.closest('.btn-ver-detalle');
        if (btn) abrirModalProducto(btn.dataset.id);
    });

    document.getElementById('cerrar-modal').addEventListener('click', () => {
        document.getElementById('modal-pedido').style.display = 'none';
    });

    document.getElementById('modal-foto-anterior').addEventListener('click', () => {
        actualizarFotoModal(indiceFotoModal - 1);
    });
    document.getElementById('modal-foto-siguiente').addEventListener('click', () => {
        actualizarFotoModal(indiceFotoModal + 1);
    });
    const galeriaModal = document.querySelector('.catalogo-modal-image-stage');
    let inicioDeslizamientoModal = null;
    galeriaModal.addEventListener('touchstart', event => {
        inicioDeslizamientoModal = event.changedTouches[0]?.clientX ?? null;
    }, { passive: true });
    galeriaModal.addEventListener('touchend', event => {
        if (inicioDeslizamientoModal === null) return;
        const desplazamiento = event.changedTouches[0].clientX - inicioDeslizamientoModal;
        if (Math.abs(desplazamiento) >= 45) {
            actualizarFotoModal(indiceFotoModal + (desplazamiento < 0 ? 1 : -1));
        }
        inicioDeslizamientoModal = null;
    }, { passive: true });
    document.getElementById('modal-pedido').addEventListener('click', event => {
        if (event.target.id === 'modal-pedido') event.currentTarget.style.display = 'none';
    });
    document.addEventListener('keydown', event => {
        const modalAbierto = document.getElementById('modal-pedido').style.display === 'flex';
        if (!modalAbierto) return;
        if (event.key === 'Escape') document.getElementById('modal-pedido').style.display = 'none';
        if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
        if (event.key === 'ArrowLeft') actualizarFotoModal(indiceFotoModal - 1);
        if (event.key === 'ArrowRight') actualizarFotoModal(indiceFotoModal + 1);
    });

    document.getElementById('btn-enviar-whatsapp').addEventListener('click', enviarPedidoWhatsApp);
});