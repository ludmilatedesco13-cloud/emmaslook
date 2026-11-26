export function comprimirImagen(file) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const objectUrl = URL.createObjectURL(file);
        const liberarUrl = () => URL.revokeObjectURL(objectUrl);

        image.onload = () => {
            try {
                if (!image.naturalWidth || !image.naturalHeight) {
                    throw new Error('El archivo no contiene dimensiones de imagen válidas.');
                }
                const escala = Math.min(1, 800 / image.naturalWidth);
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(image.naturalWidth * escala);
                canvas.height = Math.max(1, Math.round(image.naturalHeight * escala));
                const context = canvas.getContext('2d');
                if (!context) throw new Error('No se pudo preparar el compresor de imágenes.');

                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                let imagenComprimida = canvas.toDataURL('image/webp', 0.75);
                if (!imagenComprimida.startsWith('data:image/webp;base64,')) {
                    const formatoAlternativo = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
                    imagenComprimida = formatoAlternativo === 'image/jpeg'
                        ? canvas.toDataURL(formatoAlternativo, 0.75)
                        : canvas.toDataURL(formatoAlternativo);
                }
                if (!/^data:image\/(?:webp|jpeg|png);base64,/.test(imagenComprimida)) {
                    throw new Error('El navegador no pudo exportar la imagen a un formato compatible.');
                }
                resolve(imagenComprimida);
            } catch (error) {
                const detalle = error instanceof Error ? error.message : String(error);
                reject(new Error(`No se pudo comprimir la imagen "${file.name}": ${detalle}`));
            } finally {
                liberarUrl();
            }
        };
        image.onerror = () => {
            liberarUrl();
            reject(new Error(`No se pudo leer la imagen "${file.name}".`));
        };
        image.src = objectUrl;
    });
}

export function normalizarFotosProducto(value) {
    let fotos = value;
    if (typeof fotos === 'string') {
        try {
            fotos = JSON.parse(fotos);
        } catch (error) {
            console.error('No se pudieron interpretar las fotos asociadas al producto:', error);
            return [];
        }
    }
    if (!Array.isArray(fotos)) return [];
    return fotos
        .filter(foto => foto && typeof foto.image === 'string' && foto.image.trim())
        .map(foto => ({ color: String(foto.color || '').trim(), image: foto.image }));
}

export function crearGestorFotosProducto({ input, contenedor, onError }) {
    let fotos = [];
    let colores = [];

    function renderizar() {
        contenedor.replaceChildren();
        fotos.forEach((foto, index) => {
            const tarjeta = document.createElement('div');
            tarjeta.className = 'product-photo-item';

            const preview = document.createElement('img');
            preview.className = 'product-photo-preview';
            preview.src = foto.image;
            preview.alt = foto.color ? `Foto del color ${foto.color}` : 'Vista previa de foto';

            const detalles = document.createElement('div');
            detalles.className = 'product-photo-details';

            const label = document.createElement('label');
            label.textContent = 'Color de la foto';

            const select = document.createElement('select');
            select.className = 'product-photo-color';
            select.setAttribute('aria-label', `Color de la foto ${index + 1}`);
            select.add(new Option('Elegí el color', ''));
            colores.forEach(color => select.add(new Option(color, color)));
            if (foto.color && !colores.includes(foto.color)) {
                select.add(new Option(`${foto.color} (sin variante)`, foto.color));
            }
            select.value = foto.color;
            select.addEventListener('change', () => {
                foto.color = select.value;
                preview.alt = foto.color ? `Foto del color ${foto.color}` : 'Vista previa de foto';
            });
            label.appendChild(select);
            detalles.appendChild(label);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'product-photo-remove';
            remove.textContent = 'Quitar foto';
            remove.setAttribute('aria-label', `Quitar foto ${index + 1}`);
            remove.addEventListener('click', () => {
                fotos.splice(index, 1);
                renderizar();
            });

            tarjeta.append(preview, detalles, remove);
            contenedor.appendChild(tarjeta);
        });
        contenedor.hidden = fotos.length === 0;
    }

    input.addEventListener('change', async () => {
        const archivos = Array.from(input.files || []);
        if (!archivos.length) return;
        if (fotos.length + archivos.length > 8) {
            input.value = '';
            onError('Podés guardar hasta 8 fotos por prenda.');
            return;
        }
        const noValidos = archivos.find(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type));
        if (noValidos) {
            input.value = '';
            onError(`El archivo "${noValidos.name}" no es una imagen JPG, PNG o WebP válida.`);
            return;
        }
        const demasiadoGrande = archivos.find(file => file.size > 5 * 1024 * 1024);
        if (demasiadoGrande) {
            input.value = '';
            onError(`La imagen "${demasiadoGrande.name}" supera el límite de 5 MB.`);
            return;
        }
        input.disabled = true;
        try {
            const nuevasFotos = [];
            for (const archivo of archivos) {
                nuevasFotos.push({
                    color: colores.length === 1 ? colores[0] : '',
                    image: await comprimirImagen(archivo)
                });
            }

            const pesoActual = fotos.reduce((total, foto) => total + Math.floor(foto.image.length * 0.75), 0);
            const pesoSeleccionado = nuevasFotos.reduce((total, foto) => total + Math.floor(foto.image.length * 0.75), 0);
            if (pesoActual + pesoSeleccionado > 8 * 1024 * 1024) {
                throw new Error('El tamaño total de las fotos comprimidas no puede superar los 8 MB.');
            }

            fotos.push(...nuevasFotos);
            renderizar();
        } catch (error) {
            onError(error instanceof Error ? error.message : 'No se pudieron procesar las imágenes seleccionadas.');
        } finally {
            input.disabled = false;
            input.value = '';
        }
    });

    return {
        setColors(nextColors) {
            colores = [...new Set(nextColors.map(color => String(color || '').trim()).filter(Boolean))];
            renderizar();
        },
        setPhotos(nextPhotos) {
            fotos = normalizarFotosProducto(nextPhotos);
            renderizar();
        },
        getPhotos() {
            return fotos.map(foto => ({ ...foto }));
        },
        clear() {
            fotos = [];
            renderizar();
        }
    };
}
