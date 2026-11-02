import { DEFAULT_IMAGE, setProductImage } from './image-utils.js';
import { crearGestorFotosProducto, normalizarFotosProducto } from './product-photos.js';
const role = (localStorage.getItem('rol') || 'admin').toLowerCase();
let productos = [];
let variantesPorProducto = new Map();
let carritoVenta = [];
let subcategoriasPorCategoria = {}; 
let metodosPagoDisponibles = [];
let ventasParaReporte = [];
let detallesParaReporte = [];
let stockGeneralActual = 0;
let ventasResumen = [];
let productosSinStockActual = 0;
let tipoFechaVentaCache = null;
let gestorFotosProducto = null;
let fotosDetalleProducto = [];
let indiceFotoDetalleProducto = 0;

const money = value => Number(value || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const parsePrice = value => { const text = String(value ?? '').trim().replace(/\s/g, ''); if (!text) return NaN; if (text.includes(',')) return Number(text.replace(/\./g, '').replace(',', '.')); const parts = text.split('.'); return parts.length > 1 && parts.at(-1).length === 3 ? Number(parts.join('')) : Number(text); };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const showError = message => Swal.fire({ icon: 'error', title: 'Atención', text: message, confirmButtonColor: '#b89462' });
const showSuccess = (title, text) => Swal.fire({ icon: 'success', title, text, confirmButtonColor: '#b89462' });

async function obtenerTipoFechaVenta() {
    if (tipoFechaVentaCache) return tipoFechaVentaCache;
    const columnas = await executeNeonQuery(`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = current_schema()
            AND table_name = 'ventas'
            AND column_name = 'fecha'
        LIMIT 1
    `);
    tipoFechaVentaCache = columnas[0]?.data_type;
    if (!['date', 'timestamp without time zone', 'timestamp with time zone'].includes(tipoFechaVentaCache)) {
        throw new Error('No se pudo identificar el tipo de la columna ventas.fecha en la base de datos.');
    }
    return tipoFechaVentaCache;
}

async function consultarVentasConFechaLocal() {
    const tipoFecha = await obtenerTipoFechaVenta();
    let fechaLocalSql;
    if (tipoFecha === 'date') {
        fechaLocalSql = `CASE
            WHEN fecha = CURRENT_DATE
                AND CURRENT_DATE > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
            THEN (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text
            ELSE fecha::text
        END`;
    } else if (tipoFecha === 'timestamp without time zone') {
        fechaLocalSql = "(fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text";
    } else {
        fechaLocalSql = "(fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text";
    }
    return executeNeonQuery(`SELECT id, ${fechaLocalSql} AS fecha, total FROM ventas ORDER BY fecha DESC`);
}

// --- GESTIÓN DE MÉTODOS DE PAGO ---
function renderMetodosPago() {
    const select = document.getElementById('metodo_pago');
    if (select) {
        const metodoSeleccionado = select.value;
        select.innerHTML = '<option value="">Seleccioná método de pago</option>';
        metodosPagoDisponibles.forEach(metodo => {
            let texto = metodo.nombre;
            const porcentaje = Number(metodo.valor_ajuste || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
            if (metodo.tipo_ajuste === 'descuento') texto += ` (-${porcentaje}%)`;
            if (metodo.tipo_ajuste === 'recargo') texto += ` (+${porcentaje}%)`;
            select.add(new Option(texto, metodo.nombre));
        });
        select.value = metodoSeleccionado;
    }

    const selectConfig = document.getElementById('metodo_pago_config');
    if (selectConfig) {
        const metodoConfigSeleccionado = selectConfig.value;
        selectConfig.replaceChildren(new Option('-- Seleccioná un método --', ''));
        metodosPagoDisponibles.forEach(metodo => {
            selectConfig.add(new Option(metodo.nombre, metodo.id));
        });
        selectConfig.value = metodosPagoDisponibles.some(metodo => String(metodo.id) === metodoConfigSeleccionado)
            ? metodoConfigSeleccionado
            : String(metodosPagoDisponibles[0]?.id || '');
        cargarConfiguracionMetodoPago();
    }
}

async function cargarMetodosPago() {
    try {
        await executeNeonQuery(
            "DELETE FROM metodos_pago WHERE LOWER(TRIM(nombre)) IN (LOWER($1), LOWER($2))",
            ['Crédito', 'Débito']
        );
        await executeNeonQuery(
            `INSERT INTO metodos_pago (nombre, tipo_ajuste, valor_ajuste)
            SELECT metodo.nombre, NULL, 0
            FROM (VALUES ('Efectivo'), ('Tarjeta de Débito'), ('Transferencia')) AS metodo(nombre)
            WHERE NOT EXISTS (
                SELECT 1
                FROM metodos_pago existente
                WHERE LOWER(TRIM(existente.nombre)) = LOWER(metodo.nombre)
            )`
        );
        const metodos = await executeNeonQuery('SELECT * FROM metodos_pago ORDER BY id');
        metodosPagoDisponibles = metodos || [];
        renderMetodosPago();
    } catch (error) {
        console.error('Error cargando métodos de pago:', error);
        showError('No se pudieron cargar los métodos de pago: ' + error.message);
    }
}

function cargarConfiguracionMetodoPago() {
    const selectMetodo = document.getElementById('metodo_pago_config');
    const selectTipo = document.getElementById('tipo_ajuste_config');
    const inputPorcentaje = document.getElementById('valor_ajuste_config');
    if (!selectMetodo || !selectTipo || !inputPorcentaje) return;

    const metodo = metodosPagoDisponibles.find(item => String(item.id) === selectMetodo.value);
    selectTipo.value = metodo?.tipo_ajuste || '';
    inputPorcentaje.value = metodo?.valor_ajuste ?? 0;
    actualizarCampoPorcentaje();
}

function actualizarCampoPorcentaje() {
    const selectTipo = document.getElementById('tipo_ajuste_config');
    const inputPorcentaje = document.getElementById('valor_ajuste_config');
    if (!selectTipo || !inputPorcentaje) return;

    inputPorcentaje.disabled = !selectTipo.value;
    inputPorcentaje.required = Boolean(selectTipo.value);
    if (selectTipo.value === 'descuento') inputPorcentaje.max = '100';
    else inputPorcentaje.removeAttribute('max');
}

async function guardarConfiguracionMetodoPago(event) {
    event.preventDefault();
    const selectMetodo = document.getElementById('metodo_pago_config');
    const selectTipo = document.getElementById('tipo_ajuste_config');
    const inputPorcentaje = document.getElementById('valor_ajuste_config');
    const metodo = metodosPagoDisponibles.find(item => String(item.id) === selectMetodo.value);
    if (!metodo) return showError('Seleccioná un método de pago.');

    const tipoAjuste = selectTipo.value || null;
    const porcentaje = tipoAjuste ? Number(inputPorcentaje.value) : 0;
    if (tipoAjuste && (!Number.isFinite(porcentaje) || porcentaje < 0)) {
        return showError('Ingresá un porcentaje válido, igual o mayor a cero.');
    }
    if (tipoAjuste === 'descuento' && porcentaje > 100) {
        return showError('El descuento no puede superar el 100%.');
    }

    try {
        await executeNeonQuery(
            'UPDATE metodos_pago SET tipo_ajuste = $1, valor_ajuste = $2 WHERE id = $3',
            [tipoAjuste, porcentaje, metodo.id]
        );
        metodo.tipo_ajuste = tipoAjuste;
        metodo.valor_ajuste = porcentaje;
        renderMetodosPago();
        recalcularTotalVenta();
        showSuccess('Configuración guardada', `Se actualizó "${metodo.nombre}".`);
    } catch (error) {
        showError('No se pudo guardar la configuración: ' + error.message);
    }
}

// --- GESTIÓN DINÁMICA DE CATEGORÍAS Y SUBCATEGORÍAS ---
async function cargarCategoriasYSubcategorias() {
    try {
        const [resCat, resSub] = await Promise.all([
            executeNeonQuery('SELECT * FROM categorias ORDER BY nombre'),
            executeNeonQuery('SELECT * FROM subcategorias ORDER BY nombre')
        ]);

        const selectCategoria = document.getElementById('categoria');
        if (!selectCategoria) return;
        const categoriaActual = selectCategoria.value;

        selectCategoria.innerHTML = '<option value="">-- Seleccionar Categoría --</option>';
        subcategoriasPorCategoria = {};

        (resCat || []).forEach(cat => {
            selectCategoria.add(new Option(cat.nombre, cat.nombre));
            subcategoriasPorCategoria[cat.nombre] = [];
        });

        (resSub || []).forEach(sub => {
            const catRelacionada = resCat.find(c => c.id === sub.categoria_id)?.nombre;
            if (catRelacionada && subcategoriasPorCategoria[catRelacionada]) {
                subcategoriasPorCategoria[catRelacionada].push(sub.nombre);
            }
        });

        if (categoriaActual) {
            selectCategoria.value = categoriaActual;
            actualizarSubcategorias();
        }
    } catch (error) {
        console.error('Error cargando clasificaciones:', error);
    }
}

function actualizarSubcategorias() { 
    const selectSub = document.getElementById('subcategoria');
    const selectCat = document.getElementById('categoria');
    if (!selectSub || !selectCat) return;

    const catSeleccionada = selectCat.value;
    const subActual = selectSub.value;

    selectSub.innerHTML = '<option value="">-- Seleccionar Subcategoría --</option>'; 
    
    const subs = subcategoriasPorCategoria[catSeleccionada] || [];
    subs.forEach(value => selectSub.add(new Option(value, value)));

    if (subs.includes(subActual)) {
        selectSub.value = subActual;
    }
}

async function agregarNuevaCategoria() {
    const { value: nuevaCat } = await Swal.fire({
        title: 'Nueva Categoría',
        input: 'text',
        inputPlaceholder: 'Ej: Remeras, Pantalones, Vestidos...',
        showCancelButton: true,
        confirmButtonColor: '#b89462',
        cancelButtonColor: '#A95C42',
        confirmButtonText: 'Guardar',
        cancelButtonText: 'Cancelar',
        inputValidator: value => !value.trim() ? '¡Tenés que escribir un nombre!' : undefined
    });

    if (nuevaCat) {
        try {
            await executeNeonQuery('INSERT INTO categorias (nombre) VALUES ($1)', [nuevaCat.trim()]);
            await cargarCategoriasYSubcategorias();
            document.getElementById('categoria').value = nuevaCat.trim();
            actualizarSubcategorias();
            showSuccess('¡Creada!', 'La categoría fue agregada con éxito.');
        } catch (error) {
            showError('No se pudo guardar la categoría: ' + error.message);
        }
    }
}

async function agregarNuevaSubcategoria() {
    const catSeleccionada = document.getElementById('categoria').value;
    if (!catSeleccionada) return showError('Primero seleccioná una categoría para añadirle una subcategoría.');

    const { value: nuevaSub } = await Swal.fire({
        title: `Nueva Subcategoría para "${catSeleccionada}"`,
        input: 'text',
        inputPlaceholder: 'Nombre de la subcategoría...',
        showCancelButton: true,
        confirmButtonColor: '#b89462',
        cancelButtonColor: '#A95C42',
        confirmButtonText: 'Guardar',
        cancelButtonText: 'Cancelar',
        inputValidator: value => !value.trim() ? '¡Tenés que escribir un nombre!' : undefined
    });

    if (nuevaSub) {
        try {
            const catData = await executeNeonQuery('SELECT id FROM categorias WHERE nombre = $1', [catSeleccionada]);
            if (!catData.length) throw new Error('Categoría no encontrada.');

            await executeNeonQuery('INSERT INTO subcategorias (categoria_id, nombre) VALUES ($1, $2)', [catData[0].id, nuevaSub.trim()]);
            await cargarCategoriasYSubcategorias();
            document.getElementById('categoria').value = catSeleccionada;
            actualizarSubcategorias();
            document.getElementById('subcategoria').value = nuevaSub.trim();
            showSuccess('¡Creada!', 'La subcategoría fue agregada con éxito.');
        } catch (error) {
            showError('No se pudo guardar la subcategoría: ' + error.message);
        }
    }
}

async function eliminarCategoriaSeleccionada() {
    const nombre = document.getElementById('categoria').value;
    if (!nombre) return showError('Primero seleccioná una categoría.');

    const confirmacion = await Swal.fire({
        title: '¿Eliminar categoría?',
        text: `Se eliminará "${nombre}". Esta acción no se puede deshacer.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#A95C42',
        cancelButtonColor: '#b89462',
        confirmButtonText: 'Sí, eliminar',
        cancelButtonText: 'Cancelar',
        reverseButtons: true
    });
    if (!confirmacion.isConfirmed) return;

    try {
        const cat = await executeNeonQuery('SELECT id FROM categorias WHERE nombre = $1', [nombre]);
        if (!cat.length) throw new Error('Categoría no encontrada.');

        const subs = await executeNeonQuery('SELECT id FROM subcategorias WHERE categoria_id = $1', [cat[0].id]);
        if (subs.length) return showError('No se puede eliminar: primero eliminá sus subcategorías.');

        const prods = await executeNeonQuery('SELECT id FROM productos WHERE categoria = $1 LIMIT 1', [nombre]);
        if (prods.length) return showError('No se puede eliminar: la categoría está siendo usada por un producto.');

        await executeNeonQuery('DELETE FROM categorias WHERE id = $1', [cat[0].id]);
        await cargarCategoriasYSubcategorias();
        document.getElementById('categoria').value = '';
        actualizarSubcategorias();
        showSuccess('¡Categoría eliminada!', 'La categoría fue eliminada correctamente.');
    } catch (error) {
        showError('No se pudo eliminar la categoría: ' + error.message);
    }
}

async function eliminarSubcategoriaSeleccionada() {
    const categoriaNombre = document.getElementById('categoria').value;
    const nombre = document.getElementById('subcategoria').value;
    if (!categoriaNombre || !nombre) return showError('Seleccioná una categoría y una subcategoría.');

    const confirmacion = await Swal.fire({
        title: '¿Eliminar subcategoría?',
        text: `Se eliminará "${nombre}". Esta acción no se puede deshacer.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#A95C42',
        cancelButtonColor: '#b89462',
        confirmButtonText: 'Sí, eliminar',
        cancelButtonText: 'Cancelar',
        reverseButtons: true
    });
    if (!confirmacion.isConfirmed) return;

    try {
        const cat = await executeNeonQuery('SELECT id FROM categorias WHERE nombre = $1', [categoriaNombre]);
        if (!cat.length) throw new Error('Categoría no encontrada.');

        const prods = await executeNeonQuery('SELECT id FROM productos WHERE categoria = $1 AND subcategoria = $2 LIMIT 1', [categoriaNombre, nombre]);
        if (prods.length) return showError('No se puede eliminar: la subcategoría está siendo usada por un producto.');

        await executeNeonQuery('DELETE FROM subcategorias WHERE categoria_id = $1 AND nombre = $2', [cat[0].id, nombre]);
        await cargarCategoriasYSubcategorias();
        document.getElementById('categoria').value = categoriaNombre;
        actualizarSubcategorias();
        showSuccess('¡Subcategoría eliminada!', 'La subcategoría fue eliminada correctamente.');
    } catch (error) {
        showError('No se pudo eliminar la subcategoría: ' + error.message);
    }
}

// --- INVENTARIO Y PRODUCTOS (INDUMENTARIA) ---
function aplicarRol() { 
    const admin = role === 'admin'; 
    document.querySelectorAll('.admin-only').forEach(element => { element.hidden = !admin; }); 
    const usuarioElem = document.getElementById('nombre-usuario');
    if (usuarioElem) {
        usuarioElem.textContent = localStorage.getItem('usuario') || (admin ? 'Administrador' : 'Empleado'); 
    }
}

function renderDatalist() { 
    const list = document.getElementById('lista_productos'); 
    if (!list) return;
    list.innerHTML = ''; 
    productos.forEach(producto => {
        const variantes = variantesPorProducto.get(String(producto.id)) || [
            { articulo: String(producto.id), talle: producto.talle || '', color: producto.color || '', stock: Number(producto.stock || 0) }
        ];
        if (!variantes.some(variant => Number(variant.stock) > 0)) return;
        const articulos = [...new Set(variantes.map(variant => variant.articulo).filter(Boolean))];
        const label = `${producto.nombre}${producto.marca ? ` · ${producto.marca}` : ''} · Artículo ${articulos.join(', ')} · Código #${producto.id}`;
        const option = new Option(label);
        option.dataset.id = producto.id;
        list.appendChild(option);
    });
}

function agruparVariantes(variantes) {
    const agrupadas = new Map();
    (variantes || []).forEach(variant => {
        const talle = variant.talle || '';
        const color = variant.color || '';
        const key = `${talle}\u0000${color}`;
        const actual = agrupadas.get(key);
        if (actual) actual.stock += Number(variant.stock || 0);
        else agrupadas.set(key, { articulo: variant.articulo || '', talle, color, stock: Number(variant.stock || 0) });
    });
    return [...agrupadas.values()];
}

function renderInventario() { 
    const tablaInv = document.getElementById('tabla-inventario');
    if (!tablaInv) return;

    tablaInv.innerHTML = productos.length ? productos.map(p => `
        <tr>
            <td>${escapeHtml(p.id)}</td>
            <td><strong>${escapeHtml(p.nombre)}</strong></td>
            <td>${escapeHtml([...new Set((variantesPorProducto.get(String(p.id)) || []).map(variant => variant.articulo).filter(Boolean))].join(', ') || p.id)}</td>
            <td>${escapeHtml(p.marca || '-')}</td>
            <td>${escapeHtml([...new Set((variantesPorProducto.get(String(p.id)) || []).map(variant => variant.talle || '-'))].join(', ') || p.talle || '-')}</td>
            <td>${escapeHtml([...new Set((variantesPorProducto.get(String(p.id)) || []).map(variant => variant.color || '-'))].join(', ') || p.color || '-')}</td>
            <td><span class="badge-categoria">${escapeHtml(p.categoria || '-')}</span><span class="subcategoria-texto">${escapeHtml(p.subcategoria || '')}</span></td>
            <td>$${money(p.precio_venta)}</td>
            <td>${escapeHtml(p.stock)} u.</td>
            <td class="inventory-actions-cell">
                <div class="inventory-actions">
                <button type="button" class="btn-icon btn-ver" data-id="${escapeHtml(p.id)}" title="Ver Detalles">🔎</button>
                ${role === 'admin' ? `<button type="button" class="btn-icon btn-editar" data-id="${escapeHtml(p.id)}" title="Editar" style="color:#8a704d;">✏️</button><button type="button" class="btn-icon btn-eliminar" data-id="${escapeHtml(p.id)}" title="Eliminar" style="color:#A95C42;">🗑️</button>` : ''}
                </div>
            </td>
        </tr>`).join('') : '<tr><td colspan="10" style="text-align:center;">No hay prendas registradas.</td></tr>'; 
}

async function cargarProductos() { 
    await window.asegurarTablaVariantes();
    const [data, variantesIniciales] = await Promise.all([
        executeNeonQuery('SELECT * FROM productos ORDER BY id'),
        executeNeonQuery('SELECT * FROM producto_variantes ORDER BY producto_id, talle, color')
    ]);
    productos = data || []; 
    const productosConVariantes = new Set((variantesIniciales || []).map(variant => String(variant.producto_id)));
    for (const producto of productos) {
        if (!productosConVariantes.has(String(producto.id))) {
            await executeNeonQuery(
                'INSERT INTO producto_variantes (producto_id, articulo, talle, color, stock) VALUES ($1, $2, $3, $4, $5)',
                [producto.id, String(producto.id), producto.talle || '', producto.color || '', Number(producto.stock || 0)]
            );
        }
    }
    const variantes = await executeNeonQuery('SELECT * FROM producto_variantes ORDER BY producto_id, talle, color');
    variantesPorProducto = new Map();
    (variantes || []).forEach(variant => {
        const key = String(variant.producto_id);
        if (!variantesPorProducto.has(key)) variantesPorProducto.set(key, []);
        variantesPorProducto.get(key).push(variant);
    });
    variantesPorProducto.forEach((items, key) => variantesPorProducto.set(key, agruparVariantes(items)));
    renderInventario(); 
    renderDatalist(); 
}

async function cargarResumen() { 
    if (role !== 'admin') return; 
    const [ventas, stock, totalStock] = await Promise.all([
        consultarVentasConFechaLocal(),
        executeNeonQuery('SELECT id FROM productos WHERE stock = 0'),
        executeNeonQuery('SELECT COALESCE(SUM(stock), 0) AS total FROM productos')
    ]); 
    ventasResumen = ventas || [];
    productosSinStockActual = (stock || []).length;
    stockGeneralActual = Number(totalStock[0]?.total || 0);
    actualizarMetricasResumen();
}

function actualizarMetricasResumen() {
    const periodo = document.getElementById('resumen-periodo-trigger')?.dataset.period || 'month';
    const fechaReferencia = formatearFechaLocal(new Date());
    const { start, end } = obtenerRangoReporte(periodo, fechaReferencia);
    const ventasDelPeriodo = ventasResumen.filter(venta => {
        const fecha = obtenerFechaVenta(venta.fecha);
        return fecha && fecha >= start && fecha < end;
    });
    const totalVentasElem = document.getElementById('total-ventas');
    const cajaTotalElem = document.getElementById('caja-total');
    const productosSinStockElem = document.getElementById('productos-sin-stock');
    const stockTotalElem = document.getElementById('stock-total-general');

    if (totalVentasElem) totalVentasElem.textContent = ventasDelPeriodo.length;
    if (cajaTotalElem) cajaTotalElem.textContent = `$${money(ventasDelPeriodo.reduce((sum, venta) => sum + Number(venta.total || 0), 0))}`;
    if (productosSinStockElem) productosSinStockElem.textContent = productosSinStockActual;
    if (stockTotalElem) stockTotalElem.textContent = stockGeneralActual.toLocaleString('es-AR');
}

function actualizarColoresFotosProducto() {
    const colores = [...document.querySelectorAll('.variante-row .var-color')]
        .map(input => input.value.trim())
        .filter(Boolean);
    gestorFotosProducto?.setColors(colores);
}

// --- CARRITO Y CÁLCULO CON MÉTODO DE PAGO ---
function actualizarTablaCarrito() { 
    const body = document.querySelector('#tabla-carrito tbody'); 
    if (!body) return;
    body.innerHTML = carritoVenta.length ? carritoVenta.map((item, i) => `
        <tr>
            <td><strong>${escapeHtml(item.nombre)}</strong></td>
            <td>${escapeHtml(item.talle || '-')}</td>
            <td>${escapeHtml(item.color || '-')}</td>
            <td>$${money(item.precio)}</td>
            <td>${item.cantidad}</td>
            <td>$${money(item.precio * item.cantidad)}</td>
            <td><button type="button" class="btn-icon quitar-item" data-index="${i}" style="color:#A95C42;">❌</button></td>
        </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;">El carrito está vacío.</td></tr>'; 
    
    recalcularTotalVenta();
}

function calcularTotalesVenta() {
    const subtotal = carritoVenta.reduce((sum, item) => sum + item.precio * item.cantidad, 0);
    const selectMetodo = document.getElementById('metodo_pago');
    const metodoNombre = selectMetodo ? selectMetodo.value : '';
    const metodo = metodosPagoDisponibles.find(m => m.nombre === metodoNombre);
    
    let totalFinal = subtotal;
    let textoDetalle = '';

    if (metodo && subtotal > 0) {
        if (metodo.tipo_ajuste === 'descuento') {
            const descuento = subtotal * (Number(metodo.valor_ajuste) / 100);
            totalFinal = subtotal - descuento;
            textoDetalle = `Subtotal: $${money(subtotal)} | Descuento (${metodo.valor_ajuste}%): -$${money(descuento)}`;
        } else if (metodo.tipo_ajuste === 'recargo') {
            const recargo = subtotal * (Number(metodo.valor_ajuste) / 100);
            totalFinal = subtotal + recargo;
            textoDetalle = `Subtotal: $${money(subtotal)} | Recargo (${metodo.valor_ajuste}%): +$${money(recargo)}`;
        } else {
            textoDetalle = `Pago contado / sin recargos.`;
        }
    }

    const detalleCalc = document.getElementById('detalle-calculo-pago');
    if (detalleCalc) detalleCalc.textContent = textoDetalle;
    return { subtotal, totalFinal };
}

function recalcularTotalVenta() {
    const { totalFinal } = calcularTotalesVenta();
    const montoTotal = document.getElementById('monto-total-venta');
    if (montoTotal) montoTotal.textContent = money(totalFinal);
}

function agregarAlCarrito() { 
    const inputBusqueda = document.getElementById('producto_buscar');
    const inputCant = document.getElementById('cantidad');
    if (!inputBusqueda || !inputCant) return;

    const value = inputBusqueda.value.trim();
    const quantity = Number(inputCant.value);
    const option = Array.from(document.getElementById('lista_productos')?.options || [])
        .find(item => item.value === value);
    const product = option
        ? productos.find(item => String(item.id) === option.dataset.id)
        : null;
    if (!product || !Number.isInteger(quantity) || quantity <= 0) return showError('Seleccioná un producto válido y una cantidad mayor a 0.');
    seleccionarProductoVenta();
    const selectVariante = document.getElementById('variante-venta');
    const variantes = variantesPorProducto.get(String(product.id)) || [
        { articulo: String(product.id), talle: product.talle || '', color: product.color || '', stock: Number(product.stock || 0) }
    ];
    if (!selectVariante || selectVariante.value === '') {
        return showError('Seleccioná el talle y el color antes de añadir la prenda.');
    }
    const variant = variantes[Number(selectVariante.value)];
    if (!variant) return showError('Seleccioná el talle y el color antes de añadir la prenda.');
    const talle = variant.talle || '';
    const color = variant.color || '';

    const stockDisponible = Number(variant.stock);
    const articulo = variant.articulo || String(product.id);
    const existing = carritoVenta.find(item =>
        String(item.id) === String(product.id) && item.articulo === articulo && item.talle === talle && item.color === color
    );
    if (stockDisponible <= 0 || (existing?.cantidad || 0) + quantity > stockDisponible) return showError(`Stock insuficiente para talle ${talle || 'S/T'} y color ${color || 'S/C'}. Disponibles: ${stockDisponible} u.`); 
    if (existing) existing.cantidad += quantity; 
    else carritoVenta.push({ id: product.id, nombre: product.nombre, articulo, talle, color, precio: Number(product.precio_venta), cantidad: quantity }); 
    inputBusqueda.value = '';
    document.getElementById('selector-variante-venta').hidden = true;
    selectVariante.replaceChildren(new Option('Primero seleccioná una prenda', ''));
    actualizarTablaCarrito(); 
}

function seleccionarProductoVenta() {
    const inputBusqueda = document.getElementById('producto_buscar');
    const selector = document.getElementById('selector-variante-venta');
    const selectVariante = document.getElementById('variante-venta');
    if (!inputBusqueda || !selector || !selectVariante) return;

    const option = Array.from(document.getElementById('lista_productos')?.options || [])
        .find(item => item.value === inputBusqueda.value.trim());
    const product = option
        ? productos.find(item => String(item.id) === option.dataset.id)
        : null;
    if (!product) {
        selector.hidden = true;
        delete selector.dataset.productId;
        selectVariante.replaceChildren(new Option('Primero seleccioná una prenda', ''));
        return;
    }
    if (selector.dataset.productId === String(product.id) && !selector.hidden) return;

    const variantes = variantesPorProducto.get(String(product.id)) || [
        { articulo: String(product.id), talle: product.talle || '', color: product.color || '', stock: Number(product.stock || 0) }
    ];
    selectVariante.replaceChildren(new Option('Seleccioná talle y color', ''));
    variantes.forEach((variant, index) => {
        const stock = Number(variant.stock || 0);
        if (stock <= 0) return;
        selectVariante.add(new Option(
            `Artículo ${variant.articulo || product.id} · Talle ${variant.talle || 'Único'} · Color ${variant.color || 'Único'} · ${stock} u. disponibles`,
            String(index)
        ));
    });
    selector.dataset.productId = String(product.id);
    selector.hidden = false;
}

async function registrarVenta() { 
    if (!carritoVenta.length) return showError('Añadí al menos una prenda antes de finalizar la venta.'); 
    const selectMetodo = document.getElementById('metodo_pago');
    const metodoPago = selectMetodo ? selectMetodo.value : '';
    if (!metodoPago) return showError('Seleccioná un método de pago.');

    const { totalFinal } = calcularTotalesVenta(); 
    
    try { 
        await window.asegurarColumnasVariantesVenta();
        const ahora = new Date();
        const fechaVenta = new Date(Date.UTC(
            ahora.getFullYear(),
            ahora.getMonth(),
            ahora.getDate(),
            12
        )).toISOString();
        const ventaRes = await executeNeonQuery(
            "INSERT INTO ventas (fecha, total, metodo_pago) VALUES (($1::timestamptz AT TIME ZONE 'UTC'), $2, $3) RETURNING id",
            [fechaVenta, totalFinal, metodoPago]
        );
        const ventaId = ventaRes[0].id; 
        
        for (const item of carritoVenta) {
            const itemRes = await executeNeonQuery(
                `WITH stock_actualizado AS (
                    SELECT id FROM productos WHERE id = $2 AND stock >= $1 FOR UPDATE
                ),
                variante_bloqueada AS (
                    SELECT ctid, producto_id, stock FROM producto_variantes
                    WHERE producto_id::text = $2::text AND talle = $5 AND color = $6
                    FOR UPDATE
                ),
                variante_total AS (
                    SELECT SUM(stock) AS stock FROM variante_bloqueada HAVING SUM(stock) >= $1
                ),
                variante_distribuida AS (
                    SELECT ctid, producto_id, stock,
                        COALESCE(SUM(stock) OVER (
                            ORDER BY ctid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                        ), 0) AS stock_previo
                    FROM variante_bloqueada
                ),
                variante_actualizada AS (
                    UPDATE producto_variantes pv
                    SET stock = pv.stock - LEAST(vd.stock, GREATEST(0, $1 - vd.stock_previo))
                    FROM variante_distribuida vd, variante_total vt, stock_actualizado p
                    WHERE pv.ctid = vd.ctid AND vd.producto_id::text = p.id::text
                        AND LEAST(vd.stock, GREATEST(0, $1 - vd.stock_previo)) > 0
                    RETURNING pv.producto_id
                ),
                producto_actualizado AS (
                    UPDATE productos p
                    SET stock = p.stock - $1
                    FROM stock_actualizado sa
                    WHERE p.id = sa.id AND EXISTS (SELECT 1 FROM variante_actualizada)
                    RETURNING p.id
                )
                INSERT INTO detalle_venta (venta_id, producto_id, cantidad, precio_unitario, talle, color, articulo)
                SELECT $3, id, $1, $4, $5, $6, $7 FROM producto_actualizado
                RETURNING producto_id`,
                [item.cantidad, item.id, ventaId, item.precio, item.talle, item.color, item.articulo]
            );
            if (!itemRes.length) {
                throw new Error(`El stock de "${item.nombre}" cambió y ya no alcanza para completar la venta.`);
            }
        }

        carritoVenta = []; 
        if (selectMetodo) selectMetodo.value = '';
        actualizarTablaCarrito(); 
        await Promise.all([cargarProductos(), cargarResumen()]); 
        showSuccess('¡Venta Registrada! 👗', 'La operación fue exitosa y el stock ha sido actualizado.'); 
    } catch (error) { 
        showError('No se pudo registrar la venta: ' + error.message); 
    } 
}

// --- GUARDAR NUEVA PRENDA CON MÚLTIPLES VARIANTES (TALLES, COLORES, STOCKS) ---
async function guardarProducto(event) { 
    event.preventDefault(); 
    const form = event.currentTarget; 
    try { 
        const priceCost = parsePrice(document.getElementById('precio_costo').value); 
        const priceSale = parsePrice(document.getElementById('precio_venta').value); 
        
        const nombrePrenda = document.getElementById('nombre').value.trim();
        if (!nombrePrenda || !Number.isFinite(priceCost) || priceCost <= 0 || !Number.isFinite(priceSale) || priceSale <= 0) {
            throw new Error('Completá los datos obligatorios con valores válidos.'); 
        }

        // Recoger las variantes ingresadas en pantalla (Talle, Color, Stock)
        const filasVariantes = document.querySelectorAll('.variante-row');
        const listaVariantesValidas = [];
        let stockTotalGeneral = 0;

        for (const fila of filasVariantes) {
            const articulo = fila.querySelector('.var-articulo').value.trim();
            const talle = fila.querySelector('.var-talle').value.trim();
            const color = fila.querySelector('.var-color').value.trim();
            const stockVar = Number(fila.querySelector('.var-stock').value);

            if (articulo && talle && color && Number.isInteger(stockVar) && stockVar >= 0) {
                listaVariantesValidas.push({ articulo, talle, color, stock: stockVar });
                stockTotalGeneral += stockVar;
            }
        }

        if (listaVariantesValidas.length === 0) {
            throw new Error('Ingresá al menos una variante válida con artículo, talle, color y stock.');
        }
        const variantesUnicas = new Set(listaVariantesValidas.map(variant => `${variant.talle.toLocaleLowerCase()}\u0000${variant.color.toLocaleLowerCase()}`));
        if (variantesUnicas.size !== listaVariantesValidas.length) {
            throw new Error('No repitas la misma combinación de talle y color; indicá el stock total en una sola variante.');
        }

        const fotosVariantes = gestorFotosProducto?.getPhotos() || [];
        const coloresDisponibles = new Set(listaVariantesValidas.map(variant => variant.color.toLocaleLowerCase()));
        const fotoSinColor = fotosVariantes.find(foto => !foto.color || !coloresDisponibles.has(foto.color.toLocaleLowerCase()));
        if (fotoSinColor) {
            throw new Error(`Asigná a cada foto un color que esté cargado en las variantes de la prenda.`);
        }
        const fotoUrl = fotosVariantes[0]?.image || DEFAULT_IMAGE;
        
        // Tomamos el primer talle/color por defecto para mantener compatibilidad visual rápida en la tabla principal
        const tallePrincipal = listaVariantesValidas[0].talle;
        const colorPrincipal = listaVariantesValidas[0].color;

        const product = { 
            nombre: nombrePrenda, 
            marca: document.getElementById('marca').value.trim(), 
            talle: tallePrincipal,
            color: colorPrincipal,
            categoria: document.getElementById('categoria').value, 
            subcategoria: document.getElementById('subcategoria').value, 
            precio_costo: priceCost, 
            precio_venta: priceSale, 
            stock: stockTotalGeneral, // Suma total del stock de todas las variantes
            caracteristicas: document.getElementById('caracteristicas')?.value.trim() || '', 
            foto_url: fotoUrl 
        }; 
        
        await window.asegurarTablaVariantes();
        await window.asegurarColumnaFotosVariantes();
        // Insertamos el producto principal y obtenemos su ID
        const prodRes = await executeNeonQuery(
            'INSERT INTO productos (nombre, marca, talle, color, categoria, subcategoria, precio_costo, precio_venta, stock, caracteristicas, foto_url, fotos_variantes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) RETURNING id',
            [product.nombre, product.marca, product.talle, product.color, product.categoria, product.subcategoria, product.precio_costo, product.precio_venta, product.stock, product.caracteristicas, product.foto_url, JSON.stringify(fotosVariantes)]
        );
        
        const productoId = prodRes[0].id;

        for (const v of listaVariantesValidas) {
            await executeNeonQuery(
                'INSERT INTO producto_variantes (producto_id, articulo, talle, color, stock) VALUES ($1, $2, $3, $4, $5)',
                [productoId, v.articulo, v.talle, v.color, v.stock]
            );
        }

        form.reset(); 
        
        // Reiniciar contenedor de variantes a una sola fila por defecto
        const contenedor = document.getElementById('contenedor-variantes');
        if (contenedor) {
            contenedor.innerHTML = `
                <div class="form-group-row variante-row variant-row">
                    <div class="form-group">
                        <label>Artículo / Código</label>
                        <input type="text" class="var-articulo" placeholder="Ej: RB01 (se puede repetir)" required>
                    </div>
                    <div class="form-group">
                        <label>Talle</label>
                        <input type="text" class="var-talle" placeholder="Ej: S, M, 38" required>
                    </div>
                    <div class="form-group">
                        <label>Color</label>
                        <input type="text" class="var-color" placeholder="Ej: Negro" required>
                    </div>
                    <div class="form-group">
                        <label>Stock</label>
                        <input type="number" class="var-stock" min="0" value="1" required>
                    </div>
                    <div class="variant-row-action">
                        <button type="button" id="btn-agregar-variante" class="btn-add-dynamic" title="Agregar otra variante">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>
                        </button>
                    </div>
                </div>
            `;
        }

        gestorFotosProducto?.clear();
        actualizarColoresFotosProducto();

        actualizarSubcategorias(); 
        await Promise.all([cargarProductos(), cargarResumen()]); 
        showSuccess('¡Prenda Guardada! 👚', 'El artículo y sus variantes fueron registrados con éxito.'); 
    } catch (error) { 
        showError(error.message); 
    } 
}

async function eliminarProducto(id) { 
    const product = productos.find(p => String(p.id) === String(id)); 
    const confirmation = await Swal.fire({ 
        title: '¿Seguro que quieres eliminar esta prenda?', 
        text: `Se eliminará "${product?.nombre || ''}" del inventario.`, 
        icon: 'warning', 
        showCancelButton: true, 
        confirmButtonColor: '#b89462', 
        cancelButtonColor: '#A95C42', 
        confirmButtonText: 'Sí, eliminar', 
        cancelButtonText: 'Cancelar', 
        reverseButtons: true 
    }); 
    if (!confirmation.isConfirmed) return; 
    
    try {
        await executeNeonQuery('DELETE FROM producto_variantes WHERE producto_id::text = $1', [String(id)]);
        await executeNeonQuery('DELETE FROM productos WHERE id = $1', [id]);
        await Promise.all([cargarProductos(), cargarResumen()]); 
        showSuccess('¡Eliminada! 🗑️', 'La prenda fue eliminada del inventario.'); 
    } catch (error) {
        showError('No se pudo eliminar: ' + error.message);
    }
}

function mostrarDetalle(product) { 
    document.getElementById('modal-titulo-prod').textContent = product.nombre; 
    document.getElementById('modal-marca-prod').textContent = product.marca || 'N/A'; 
    const variantes = variantesPorProducto.get(String(product.id)) || [];
    document.getElementById('modal-talle-prod').textContent = variantes.map(variant => variant.talle || 'N/A').join(', ') || product.talle || 'N/A';
    document.getElementById('modal-color-prod').textContent = variantes.map(variant => variant.color || 'N/A').join(', ') || product.color || 'N/A';
    document.getElementById('modal-precio-prod').textContent = money(product.precio_venta); 
    document.getElementById('modal-stock-prod').textContent = product.stock; 
    document.getElementById('modal-info-prod').textContent = product.caracteristicas || 'Sin descripción.'; 
    fotosDetalleProducto = normalizarFotosProducto(product.fotos_variantes)
        .filter((foto, index, fotos) => fotos.findIndex(otra => otra.image === foto.image) === index);
    const imagenLegacy = product.foto_url || product.foto;
    if (imagenLegacy && !fotosDetalleProducto.some(foto => foto.image === imagenLegacy)) {
        fotosDetalleProducto.unshift({ color: product.color || '', image: imagenLegacy });
    }
    if (!fotosDetalleProducto.length) fotosDetalleProducto = [{ color: '', image: DEFAULT_IMAGE }];
    indiceFotoDetalleProducto = 0;
    actualizarFotoDetalleProducto();
    document.getElementById('modal-detalles').style.display = 'flex'; 
}

function actualizarFotoDetalleProducto(direccion = 0) {
    if (!fotosDetalleProducto.length) return;
    indiceFotoDetalleProducto = (indiceFotoDetalleProducto + direccion + fotosDetalleProducto.length) % fotosDetalleProducto.length;
    const foto = fotosDetalleProducto[indiceFotoDetalleProducto];
    const imagen = document.getElementById('modal-img-prod');
    setProductImage(imagen, foto.image);
    imagen.alt = foto.color ? `Foto del color ${foto.color}` : 'Foto del producto';
    const contador = document.getElementById('modal-contador-fotos-prod');
    const anterior = document.getElementById('modal-foto-anterior-prod');
    const siguiente = document.getElementById('modal-foto-siguiente-prod');
    const mostrarControles = fotosDetalleProducto.length > 1;
    contador.textContent = `${indiceFotoDetalleProducto + 1} / ${fotosDetalleProducto.length}${foto.color ? ` · ${foto.color}` : ''}`;
    contador.hidden = !mostrarControles;
    anterior.hidden = !mostrarControles;
    siguiente.hidden = !mostrarControles;
}

function formatearFechaLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function obtenerRangoReporte(periodo, fechaReferencia) {
    const [year, month, day] = fechaReferencia.split('-').map(Number);
    const start = new Date(year, month - 1, day);
    let end = new Date(start);
    let label;
    if (periodo === 'day') {
        end.setDate(end.getDate() + 1);
        label = start.toLocaleDateString('es-AR');
    } else if (periodo === 'week') {
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        end = new Date(start);
        end.setDate(end.getDate() + 7);
        const lastDay = new Date(end);
        lastDay.setDate(lastDay.getDate() - 1);
        label = `${start.toLocaleDateString('es-AR')} al ${lastDay.toLocaleDateString('es-AR')}`;
    } else if (periodo === 'year') {
        start.setMonth(0, 1);
        end = new Date(start.getFullYear() + 1, 0, 1);
        label = String(start.getFullYear());
    } else {
        start.setDate(1);
        end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
        label = start.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    }
    return { start: formatearFechaLocal(start), end: formatearFechaLocal(end), label };
}

function obtenerFechaVenta(fecha) {
    const text = String(fecha || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const timestampSinZona = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text);
    const parsed = new Date(timestampSinZona ? `${text.replace(' ', 'T')}Z` : text);
    return Number.isNaN(parsed.getTime()) ? '' : formatearFechaLocal(parsed);
}

function actualizarReporteFiltrado() {
    const periodo = document.getElementById('reporte-periodo').value;
    const fechaReferencia = document.getElementById('reporte-fecha').value;
    if (!fechaReferencia) return;
    const { start, end, label } = obtenerRangoReporte(periodo, fechaReferencia);
    const sales = ventasParaReporte.filter(sale => {
        const date = obtenerFechaVenta(sale.fecha);
        return date && date >= start && date < end;
    });
    const saleIds = new Set(sales.map(sale => String(sale.id)));
    const details = detallesParaReporte.filter(detail => saleIds.has(String(detail.venta_id)));
    const best = {};
    details.forEach(detail => {
        const productLabel = `${detail.nombre} (Artículo: ${detail.articulo || '-'}, Talle: ${detail.talle || '-'}, Color: ${detail.color || '-'})`;
        best[productLabel] = best[productLabel] || { brand: detail.marca || '-', count: 0 };
        best[productLabel].count += Number(detail.cantidad || 0);
    });
    const total = sales.reduce((sum, sale) => sum + Number(sale.total || 0), 0);
    const units = details.reduce((sum, detail) => sum + Number(detail.cantidad || 0), 0);
    const resultadoEst = document.getElementById('resultadoEstadisticas');
    if (resultadoEst) {
        const topProducts = Object.entries(best)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 5);
        resultadoEst.innerHTML = `
            <h3 style="color:#332720;margin-bottom:12px;">Resumen: ${escapeHtml(label)}</h3>
            <div class="resumen-grid" style="margin-bottom:18px;">
                <div class="resumen-item"><p>Ventas</p><strong>${sales.length}</strong></div>
                <div class="resumen-item mid"><p>Total recaudado</p><strong>$${money(total)}</strong></div>
                <div class="resumen-item"><p>Unidades</p><strong>${units}</strong></div>
            </div>
                <div class="stock-total-indicator" style="margin-bottom:18px;">
                    <span>Stock general actual en el local</span>
                    <strong>${stockGeneralActual.toLocaleString('es-AR')} prendas</strong>
                    ${periodo === 'day' ? `<span>Vendidas en el día seleccionado: ${units} prendas</span>` : ''}
                </div>
                <h3 style="color:#332720;">👗 Prendas más Vendidas</h3>
            <ul style="list-style:none;padding:0;">${topProducts.map(([name, item]) => `<li style="padding:8px 0;border-bottom:1px solid #e4d8c8;display:flex;justify-content:space-between;gap:12px;"><span>🛍️ <strong>${escapeHtml(name)}</strong> (${escapeHtml(item.brand)})</span><strong>${item.count} un.</strong></li>`).join('') || '<li>No hay ventas en este período.</li>'}</ul>`;
    }
    window.reporte = { sales, best, label, units, total, stockGeneral: stockGeneralActual };
}

async function cargarReporte() { 
    await window.asegurarColumnasVariantesVenta();
    const [sales, details, totalStock] = await Promise.all([
        consultarVentasConFechaLocal(),
        executeNeonQuery(`
            SELECT dv.venta_id, dv.cantidad, p.nombre, p.marca, dv.articulo, COALESCE(dv.talle, p.talle) AS talle, COALESCE(dv.color, p.color) AS color
            FROM detalle_venta dv 
            JOIN productos p ON dv.producto_id = p.id
        `),
        executeNeonQuery('SELECT COALESCE(SUM(stock), 0) AS total FROM productos')
    ]); 
    ventasParaReporte = sales || [];
    detallesParaReporte = details || [];
    stockGeneralActual = Number(totalStock[0]?.total || 0);
    const stockTotalElem = document.getElementById('stock-total-general');
    if (stockTotalElem) stockTotalElem.textContent = stockGeneralActual.toLocaleString('es-AR');
    actualizarReporteFiltrado();
}

function descargarReporte() { 
    const report = window.reporte || { sales: [], best: {}, label: 'período', units: 0, total: 0, stockGeneral: stockGeneralActual }; 
    const rows = [['Período', report.label], ['Cantidad de ventas', report.sales.length], ['Unidades vendidas', report.units], ['Total recaudado ($)', Number(report.total || 0).toFixed(2).replace('.', ',')], ['Stock general actual', report.stockGeneral]];
    rows.push([], ['Prenda / Variante', 'Marca', 'Unidades Vendidas']); 
    Object.entries(report.best).forEach(([name, item]) => rows.push([name, item.brand, item.count])); 
    
    const csv = '\uFEFF' + rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n'); 
    const link = document.createElement('a'); 
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); 
    link.download = `reporte_emmas_look_${document.getElementById('reporte-fecha').value}.csv`; 
    link.click(); 
    showSuccess('¡Reporte descargado!', 'El archivo CSV se generó con éxito.'); 
}

document.addEventListener('DOMContentLoaded', async () => { 
    if (!localStorage.getItem('usuario')) { window.location.replace('login.html'); return; } 
    aplicarRol(); 
    actualizarTablaCarrito(); 

    await Promise.all([
        cargarCategoriasYSubcategorias(),
        cargarMetodosPago()
    ]);
    
    const selectCat = document.getElementById('categoria');
    if (selectCat) selectCat.addEventListener('change', actualizarSubcategorias); 

    const selectMetodo = document.getElementById('metodo_pago');
    if (selectMetodo) selectMetodo.addEventListener('change', recalcularTotalVenta);

    const selectMetodoConfig = document.getElementById('metodo_pago_config');
    if (selectMetodoConfig) selectMetodoConfig.addEventListener('change', cargarConfiguracionMetodoPago);

    const selectTipoAjuste = document.getElementById('tipo_ajuste_config');
    if (selectTipoAjuste) selectTipoAjuste.addEventListener('change', actualizarCampoPorcentaje);

    const formMetodoPagoConfig = document.getElementById('form-config-metodo-pago');
    if (formMetodoPagoConfig) formMetodoPagoConfig.addEventListener('submit', guardarConfiguracionMetodoPago);
    
    const btnNewCat = document.getElementById('btn-nueva-categoria');
    if (btnNewCat) btnNewCat.addEventListener('click', agregarNuevaCategoria);

    const btnNewSub = document.getElementById('btn-nueva-subcategoria');
    if (btnNewSub) btnNewSub.addEventListener('click', agregarNuevaSubcategoria);

    const btnDelCat = document.getElementById('btn-eliminar-categoria');
    if (btnDelCat) btnDelCat.addEventListener('click', eliminarCategoriaSeleccionada);

    const btnDelSub = document.getElementById('btn-eliminar-subcategoria');
    if (btnDelSub) btnDelSub.addEventListener('click', eliminarSubcategoriaSeleccionada);

    const btnAddItem = document.getElementById('btn-agregar-item');
    if (btnAddItem) btnAddItem.addEventListener('click', agregarAlCarrito); 

    const prodBuscar = document.getElementById('producto_buscar');
    if (prodBuscar) {
        prodBuscar.addEventListener('input', seleccionarProductoVenta);
        prodBuscar.addEventListener('change', seleccionarProductoVenta);
        prodBuscar.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                seleccionarProductoVenta();
                const selectorVariante = document.getElementById('selector-variante-venta');
                const variante = document.getElementById('variante-venta');
                if (!selectorVariante.hidden) {
                    if (!variante.value) variante.focus();
                    else agregarAlCarrito();
                }
            }
        });
    }
    
    const tablaCarritoBody = document.querySelector('#tabla-carrito tbody');
    if (tablaCarritoBody) {
        tablaCarritoBody.addEventListener('click', event => { 
            const button = event.target.closest('.quitar-item'); 
            if (button) { carritoVenta.splice(Number(button.dataset.index), 1); actualizarTablaCarrito(); } 
        }); 
    }
    
    const formVentas = document.getElementById('form-ventas-multiples');
    if (formVentas) formVentas.addEventListener('submit', event => { event.preventDefault(); registrarVenta(); }); 

    const formProducto = document.getElementById('form-nuevo-producto');
    if (formProducto) formProducto.addEventListener('submit', guardarProducto); 

    const inputFotos = document.getElementById('foto');
    const contenedorFotos = document.getElementById('contenedor-fotos-producto');
    const contenedorVariantes = document.getElementById('contenedor-variantes');
    if (inputFotos && contenedorFotos && contenedorVariantes) {
        gestorFotosProducto = crearGestorFotosProducto({
            input: inputFotos,
            contenedor: contenedorFotos,
            onError: showError
        });
        contenedorVariantes.addEventListener('input', actualizarColoresFotosProducto);
        contenedorVariantes.addEventListener('click', event => {
            if (event.target.closest('#btn-agregar-variante, .btn-eliminar-variante')) {
                requestAnimationFrame(actualizarColoresFotosProducto);
            }
        });
        actualizarColoresFotosProducto();
    }
    
    const tablaInventario = document.getElementById('tabla-inventario');
    if (tablaInventario) {
        tablaInventario.addEventListener('click', event => { 
            const button = event.target.closest('button'); 
            if (!button) return; 
            const product = productos.find(item => String(item.id) === button.dataset.id); 
            if (!product) return; 
            if (button.classList.contains('btn-ver')) mostrarDetalle(product); 
            if (button.classList.contains('btn-editar')) window.location.href = `editar-producto.html?id=${encodeURIComponent(product.id)}`; 
            if (button.classList.contains('btn-eliminar')) eliminarProducto(product.id); 
        }); 
    }
    
    const btnCloseModal = document.getElementById('btn-close-modal');
    if (btnCloseModal) btnCloseModal.addEventListener('click', () => { document.getElementById('modal-detalles').style.display = 'none'; });
    document.getElementById('modal-foto-anterior-prod')?.addEventListener('click', () => actualizarFotoDetalleProducto(-1));
    document.getElementById('modal-foto-siguiente-prod')?.addEventListener('click', () => actualizarFotoDetalleProducto(1));
    const visorFotosDetalle = document.querySelector('.detail-photo-viewer');
    let inicioDeslizamientoDetalle = null;
    visorFotosDetalle?.addEventListener('touchstart', event => {
        inicioDeslizamientoDetalle = event.changedTouches[0]?.clientX ?? null;
    }, { passive: true });
    visorFotosDetalle?.addEventListener('touchend', event => {
        if (inicioDeslizamientoDetalle === null) return;
        const desplazamiento = event.changedTouches[0].clientX - inicioDeslizamientoDetalle;
        if (Math.abs(desplazamiento) >= 45) actualizarFotoDetalleProducto(desplazamiento < 0 ? 1 : -1);
        inicioDeslizamientoDetalle = null;
    }, { passive: true });
    document.addEventListener('keydown', event => {
        const modalDetallesAbierto = document.getElementById('modal-detalles')?.style.display === 'flex';
        if (!modalDetallesAbierto) return;
        if (event.key === 'Escape') document.getElementById('modal-detalles').style.display = 'none';
        if (event.key === 'ArrowLeft') actualizarFotoDetalleProducto(-1);
        if (event.key === 'ArrowRight') actualizarFotoDetalleProducto(1);
    });

    const btnReporte = document.getElementById('btnReporte');
    if (btnReporte) {
        btnReporte.addEventListener('click', async event => { 
            event.preventDefault(); 
            const modalRep = document.getElementById('modalReporte');
            if (modalRep) modalRep.style.display = 'flex'; 
            try { await cargarReporte(); } catch (error) { showError(error.message); } 
        }); 
    }

    const resumenPeriodoTrigger = document.getElementById('resumen-periodo-trigger');
    const resumenPeriodoMenu = document.getElementById('resumen-periodo-menu');
    if (resumenPeriodoTrigger && resumenPeriodoMenu) {
        const cerrarMenuPeriodo = ({ devolverFoco = false } = {}) => {
            resumenPeriodoMenu.hidden = true;
            resumenPeriodoTrigger.setAttribute('aria-expanded', 'false');
            if (devolverFoco) resumenPeriodoTrigger.focus();
        };

        resumenPeriodoTrigger.addEventListener('click', () => {
            const menuAbierto = resumenPeriodoTrigger.getAttribute('aria-expanded') === 'true';
            resumenPeriodoMenu.hidden = menuAbierto;
            resumenPeriodoTrigger.setAttribute('aria-expanded', String(!menuAbierto));
        });

        resumenPeriodoMenu.addEventListener('click', event => {
            const opcion = event.target.closest('.stats-period-option');
            if (!opcion) return;

            resumenPeriodoTrigger.dataset.period = opcion.dataset.period;
            const etiqueta = opcion.textContent.trim();
            document.getElementById('resumen-periodo-label').textContent = etiqueta;
            resumenPeriodoTrigger.setAttribute('aria-label', `Período del resumen: ${etiqueta}`);
            resumenPeriodoMenu.querySelectorAll('.stats-period-option').forEach(item => {
                item.setAttribute('aria-checked', String(item === opcion));
            });
            cerrarMenuPeriodo({ devolverFoco: true });
            actualizarMetricasResumen();
        });

        document.addEventListener('click', event => {
            if (!event.target.closest('.stats-period-picker') && !resumenPeriodoMenu.hidden) {
                cerrarMenuPeriodo();
            }
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !resumenPeriodoMenu.hidden) {
                cerrarMenuPeriodo({ devolverFoco: true });
            }
        });
    }

    const fechaReporte = document.getElementById('reporte-fecha');
    const periodoReporte = document.getElementById('reporte-periodo');
    if (fechaReporte && periodoReporte) {
        fechaReporte.value = formatearFechaLocal(new Date());
        fechaReporte.addEventListener('change', actualizarReporteFiltrado);
        periodoReporte.addEventListener('change', actualizarReporteFiltrado);
    }

    const btnExportar = document.getElementById('btn-exportar');
    if (btnExportar) btnExportar.addEventListener('click', descargarReporte); 

    const cerrarModalRep = document.getElementById('cerrarModalReporte');
    if (cerrarModalRep) cerrarModalRep.addEventListener('click', () => { document.getElementById('modalReporte').style.display = 'none'; }); 

    const btnSalir = document.getElementById('btn-salir');
    if (btnSalir) btnSalir.addEventListener('click', () => { localStorage.clear(); window.location.href = 'login.html'; }); 
    
    try { 
        await Promise.all([cargarProductos(), cargarResumen()]); 
    } catch (error) { 
        showError(`No se pudo cargar la información: ${error.message}`); 
    } 
});