import { Component, onWillStart, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardActionServiceProps } from "@web/webclient/actions/action_service";
import { PanelCalificacion } from "./panel_calificacion";

// Mismo orden de progresión que la Selection de cinta_actual/cinta_evaluada
// en Python. Lo usamos para que "ordenar por Cinta" siga el avance real de
// las cintas y no el orden alfabético (que mezclaría amarilla antes que azul
// antes que blanca, sin sentido para una academia de taekwondo).
const ORDEN_CINTAS = [
    "blanca", "naranja", "naranja_avanzada", "amarilla", "amarilla_avanzada",
    "verde", "verde_avanzada", "azul", "azul_avanzada", "roja", "roja_avanzada", "negra",
];
const RANGO_CINTA = Object.fromEntries(ORDEN_CINTAS.map((cinta, indice) => [cinta, indice]));

// resultado ya viene en español desde el modelo (aprobado/reprobado/pendiente),
// así que basta un mapeo fijo de despliegue - a diferencia de cinta_evaluada,
// aquí no hace falta pedirle la Selection al servidor vía fields_get.
const RESULTADO_LABELS = {
    aprobado: "Aprobado",
    reprobado: "Reprobado",
    pendiente: "Pendiente",
};

// Geometría de la "mesa": un lienzo de posición libre donde el sinodal
// arrastra las tarjetas para reproducir la distribución física real de los
// alumnos durante el examen. Es una vista PERSONAL: no se sincroniza entre
// distintos sinodales/dispositivos.
// Ancho de la tarjeta COMPACTA (cerrada). Estimado, a validar en navegador.
const ANCHO_TARJETA = 190;
// Ancho de cada panel abierto en el dock (franja bajo la mesa),
// independiente del de la tarjeta compacta.
const ANCHO_PANEL = 360;
// Alto FIJO de la tarjeta compacta (lo impone estiloCardBox). Abrir una
// tarjeta no cambia su tamaño en el lienzo: su panel va al dock, fuera del
// lienzo. Estimado, a validar en navegador.
const ALTO_TARJETA = 64;
// Alturas del marco de la mesa y del dock (estimados, a validar en
// navegador). Sin paneles abiertos el marco usa ALTO_MARCO_SIN_DOCK; con
// dock se encoge a ALTO_MARCO_CON_DOCK para dejarle espacio debajo, y cada
// panel del dock tiene su propio scroll vertical a partir de ALTO_PANEL_DOCK.
const ALTO_MARCO_SIN_DOCK = "calc(100vh - 220px)";
const ALTO_MARCO_CON_DOCK = "40vh";
const ALTO_PANEL_DOCK = "50vh";
const ANCHO_LIENZO = 1400;
const ANCHO_LIENZO_MAX = 4000;
const ALTO_LIENZO_MAX = 3000;
const SEPARACION = 16;
const HOLGURA_ENCIMADO = 40;       // px de traslape tolerado antes de considerar "encimadas"
const MARGEN_MINIMO = 2;           // separación mínima al buscar hueco libre para una card nueva
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1;
const ZOOM_PASO = 0.1;
// Base de z-index de la cabecera de cada tarjeta; se le SUMA su prioridad
// (ver _prioridad) para que la última tarjeta arrastrada o abierta quede
// encima de otras cerradas con las que se encime.
const Z_HEADER_BASE = 500;

export class TableroCalificacion extends Component {
    static template = "mi_primer_modulo.TableroCalificacion";
    static components = { PanelCalificacion };
    static props = {
        ...standardActionServiceProps,
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.lienzoRef = useRef("lienzo");

        this.state = useState({
            cargando: true,
            roster: [],
            ordenPor: "edad",
            rosterColapsado: false,
            // 'mesa': exámenes en la mesa. 'posiciones': {examenId: {x, y}} en
            // px dentro del lienzo = posición CANÓNICA, la que persiste en
            // posicion_x/posicion_y y que SOLO cambia el drag-and-drop libre.
            // 'tarjetasAbiertas': cuáles muestran su panel en el dock, en
            // ese orden (de izquierda a derecha).
            // 'zIndices': {examenId: numero} orden de "traída al frente";
            // más alto = más arriba visualmente cuando dos tarjetas se enciman.
            // 'expandido': tarjeta a pantalla completa, o null.
            // 'zoom': factor de escala manual del tablero completo (0.5-1).
            mesa: [],
            posiciones: {},
            tarjetasAbiertas: [],
            zIndices: {},
            expandido: null,
            zoom: ZOOM_MAX,
            progreso: {},
        });

        // Arrastre libre en curso. No es estado reactivo: solo vive entre
        // pointerdown y pointerup/pointercancel de un mismo gesto.
        this._arrastre = null;
        // Contador monótono para "traer al frente" (abrir o arrastrar una
        // card le asigna el siguiente número; nunca baja).
        this._zSiguiente = 10;

        onWillStart(async () => {
            const eventoId = this.props.action.params.evento_id;

            const examenes = await this.orm.searchRead(
                "taekwondo.examen",
                [["evento_id", "=", eventoId]],
                [
                    "alumno_id", "cinta_evaluada", "resultado", "mejor_examen",
                    "posicion_x", "posicion_y", "en_mesa",
                ]
            );

            const alumnoIds = [...new Set(examenes.map((examen) => examen.alumno_id[0]))];

            // UNA sola llamada trae los datos de TODOS los alumnos del
            // roster juntos, en vez de un viaje al servidor por cada uno.
            const alumnos = await this.orm.read(
                "taekwondo.alumno",
                alumnoIds,
                ["name", "foto", "edad"]
            );
            const alumnosPorId = Object.fromEntries(
                alumnos.map((alumno) => [alumno.id, alumno])
            );

            // orm.read/searchRead traen el valor CRUDO de un campo Selection
            // (la clave técnica, ej. "verde_avanzada"), no la etiqueta
            // traducida - esa traducción normalmente la hace el widget de
            // las vistas estándar de Odoo, usando la metadata del campo que
            // trae fields_get. Como aquí no hay vista ni widget, la pedimos
            // nosotros mismos, UNA sola vez (no por cada examen).
            const camposExamen = await this.orm.call("taekwondo.examen", "fields_get", [], {
                allfields: ["cinta_evaluada"],
                attributes: ["selection"],
            });
            const cintaLabels = Object.fromEntries(camposExamen.cinta_evaluada.selection);

            this.state.roster = examenes.map((examen) => {
                const alumno = alumnosPorId[examen.alumno_id[0]];
                return {
                    examenId: examen.id,
                    name: alumno.name,
                    foto: alumno.foto,
                    edad: alumno.edad,
                    // Guardamos AMBOS: el valor crudo (cintaEvaluada) sigue
                    // siendo necesario para ordenar con RANGO_CINTA, y la
                    // etiqueta (cintaEvaluadaLabel) es la que se muestra.
                    cintaEvaluada: examen.cinta_evaluada,
                    cintaEvaluadaLabel: cintaLabels[examen.cinta_evaluada] || examen.cinta_evaluada,
                    resultado: examen.resultado,
                    mejorExamen: examen.mejor_examen,
                };
            });

            // Otra llamada batch (no una por examen): trae de un solo golpe
            // los criterios de TODOS los exámenes del evento, y con eso
            // contamos cuántos ya tienen calificación por examen.
            const criteriosTodos = await this.orm.searchRead(
                "taekwondo.criterio_calificacion",
                [["examen_id", "in", examenes.map((examen) => examen.id)]],
                ["examen_id", "calificacion"]
            );
            const progreso = Object.fromEntries(examenes.map((examen) => [examen.id, 0]));
            for (const criterio of criteriosTodos) {
                if (criterio.calificacion) {
                    progreso[criterio.examen_id[0]] += 1;
                }
            }
            this.state.progreso = progreso;

            // Restaurar la mesa personal: el criterio de pertenencia es
            // en_mesa (persistido), NO la posición. posicion_x/y solo dicen
            // DÓNDE va si está en la mesa, ya no SI está en la mesa - ver
            // quitarDeMesa/agregarAMesa.
            const mesa = [];
            const posiciones = {};
            for (const examen of examenes) {
                if (examen.en_mesa) {
                    mesa.push(examen.id);
                }
                if (examen.posicion_x || examen.posicion_y) {
                    posiciones[examen.id] = { x: examen.posicion_x, y: examen.posicion_y };
                }
            }
            this.state.mesa = mesa;
            this.state.posiciones = posiciones;

            this.state.cargando = false;
        });
    }

    // ---- roster / orden --------------------------------------------------

    get rosterOrdenado() {
        // Copiamos el arreglo antes de ordenar: sort() ordena "en el lugar",
        // y modificar el estado reactivo directamente desde un getter que
        // se llama en cada render es una mala práctica (podría disparar
        // renders extra o dejar el orden inconsistente entre pantallas).
        const roster = [...this.state.roster];
        if (this.state.ordenPor === "edad") {
            roster.sort((a, b) => a.edad - b.edad);
        } else {
            roster.sort((a, b) => RANGO_CINTA[a.cintaEvaluada] - RANGO_CINTA[b.cintaEvaluada]);
        }
        return roster;
    }

    get rosterPorExamenId() {
        return Object.fromEntries(this.state.roster.map((item) => [item.examenId, item]));
    }

    ordenarPor(criterio) {
        this.state.ordenPor = criterio;
    }

    alternarRoster() {
        this.state.rosterColapsado = !this.state.rosterColapsado;
    }

    // ---- mesa: agregar / quitar / abrir / expandir ---------------------

    async agregarAMesa(examenId) {
        if (this.state.mesa.includes(examenId)) {
            return;
        }
        // Si ya tenía posición (el sinodal lo había acomodado y luego lo
        // quitó), se respeta y reaparece ahí. Solo si nunca tuvo posición
        // se le asigna un hueco automático (para que no aparezca amontonada
        // en 0,0 encima de otra card).
        if (!this.state.posiciones[examenId]) {
            this.state.posiciones[examenId] = this._siguienteSlot();
        }
        this.state.mesa.push(examenId);
        try {
            await this.orm.write("taekwondo.examen", [examenId], { en_mesa: true });
        } catch (error) {
            // Reversión optimista: si no se pudo persistir, el alumno no
            // se queda "en la mesa" solo en el navegador de este sinodal -
            // eso volvería a divergir del servidor, el mismo tipo de bug
            // que estamos arreglando.
            this.state.mesa = this.state.mesa.filter((id) => id !== examenId);
            this.notification.add(
                "No se pudo agregar el alumno a la mesa. Intenta de nuevo.",
                { type: "danger" }
            );
        }
    }

    async quitarDeMesa(examenId) {
        // "Quitar" es PURAMENTE VISUAL: solo saca el examenId del arreglo
        // 'mesa' y persiste en_mesa=False. NO se borra 'state.posiciones'
        // ni se toca posicion_x/posicion_y en el servidor, para que al
        // volver a agregar al alumno con "+" reaparezca exactamente donde
        // el sinodal lo dejó.
        this.state.mesa = this.state.mesa.filter((id) => id !== examenId);
        this.state.tarjetasAbiertas = this.state.tarjetasAbiertas.filter((id) => id !== examenId);
        if (this.state.expandido === examenId) {
            this.state.expandido = null;
        }
        try {
            await this.orm.write("taekwondo.examen", [examenId], { en_mesa: false });
        } catch (error) {
            // Revertimos SOLO la pertenencia a la mesa: tarjetasAbiertas y
            // expandido no se restauran porque su estado no es lo que
            // falló en persistir y reabrir/expandir de vuelta sin que el
            // usuario lo pidiera sería más confuso que útil.
            this.state.mesa.push(examenId);
            this.notification.add(
                "No se pudo quitar el alumno de la mesa. Intenta de nuevo.",
                { type: "danger" }
            );
        }
    }

    estaAbierta(examenId) {
        return this.state.tarjetasAbiertas.includes(examenId);
    }

    alternarTarjeta(examenId) {
        if (this.state.tarjetasAbiertas.includes(examenId)) {
            this.state.tarjetasAbiertas = this.state.tarjetasAbiertas.filter((id) => id !== examenId);
        } else {
            this.state.tarjetasAbiertas.push(examenId);
            this._traerAlFrente(examenId);
        }
    }

    expandir(examenId) {
        this.state.expandido = examenId;
    }

    regresar() {
        this.state.expandido = null;
    }

    etiquetaResultado(valor) {
        return RESULTADO_LABELS[valor] || valor;
    }

    // ---- geometría del lienzo -----------------------------------------

    get altoLienzo() {
        // Alto real de cada card SIEMPRE es ALTO_TARJETA (su panel abierto
        // va al dock, fuera del lienzo): el lienzo crece solo según hasta
        // dónde se arrastró alguna card.
        let maxAbajo = 700;
        for (const id of this.state.mesa) {
            maxAbajo = Math.max(maxAbajo, this._pos(id).y + ALTO_TARJETA);
        }
        return Math.min(maxAbajo + 80, ALTO_LIENZO_MAX);
    }

    get anchoLienzo() {
        let maxDerecha = ANCHO_LIENZO;
        for (const id of this.state.mesa) {
            maxDerecha = Math.max(maxDerecha, this._pos(id).x + ANCHO_TARJETA + 80);
        }
        return Math.min(maxDerecha, ANCHO_LIENZO_MAX);
    }

    // Estilo del canvas: tamaño dinámico (crece con las cards) + el zoom
    // manual aplicado a TODO el lienzo, nunca a las cards individuales.
    get estiloLienzo() {
        return `position: relative; width: ${this.anchoLienzo}px; height: ${this.altoLienzo}px; ` +
            `transform: scale(${this.state.zoom}); transform-origin: top left;`;
    }

    // Posición libre de cada card: x/y propios y ancho fijo de tarjeta
    // compacta. SIN z-index propio a propósito: si el wrapper tuviera un
    // z-index numérico, se volvería un stacking context nuevo y atraparía
    // dentro suyo a la cabecera, impidiéndole competir por z-index contra
    // las de las demás cards - ver estiloCabecera.
    estiloTarjeta(examenId) {
        const p = this._pos(examenId);
        return `position: absolute; left: ${p.x}px; top: ${p.y}px; width: ${ANCHO_TARJETA}px;`;
    }

    // Contenedor externo (el que lleva el borde de color por resultado).
    // height = ALTO_TARJETA (border-box, borde incluido): fija el alto de la
    // tarjeta compacta para que coincida con _headerRect. Si su panel está
    // abierto en el dock, se resalta con un outline del color primario, que
    // no cambia el color del borde de resultado ni el tamaño de la card.
    estiloCardBox(examenId) {
        const base = `position: relative; height: ${ALTO_TARJETA}px;`;
        return this.estaAbierta(examenId)
            ? `${base} outline: 3px solid var(--bs-primary); outline-offset: 2px;`
            : base;
    }

    // Cabecera de la tarjeta compacta: Z_HEADER_BASE + prioridad, para que
    // la última card arrastrada o abierta pinte encima de otras cerradas con
    // las que se encime. position:relative para que el z-index aplique.
    estiloCabecera(examenId) {
        const prioridad = this._prioridad(examenId);
        return `position: relative; z-index: ${Z_HEADER_BASE + prioridad};`;
    }

    // ---- dock de paneles abiertos -------------------------------------

    // Marco de la mesa: se encoge cuando hay dock debajo para dejarle sitio.
    get estiloMarco() {
        const alto = this.state.tarjetasAbiertas.length ? ALTO_MARCO_CON_DOCK : ALTO_MARCO_SIN_DOCK;
        return `overflow: auto; max-height: ${alto};`;
    }

    // Cada panel del dock: ancho fijo (no se encoge al haber varios; el dock
    // hace scroll horizontal) y scroll vertical propio.
    get estiloPanelDock() {
        return `width: ${ANCHO_PANEL}px; flex-shrink: 0; max-height: ${ALTO_PANEL_DOCK}; overflow-y: auto;`;
    }

    // ---- geometría / colisión (rectángulos) -----------------------------

    _pos(examenId) {
        return this.state.posiciones[examenId] || { x: 0, y: 0 };
    }

    _rect(pos, dims) {
        return { x: pos.x, y: pos.y, w: dims.w, h: dims.h };
    }

    _solapeEje(a0, a1, b0, b1) {
        return Math.min(a1, b1) - Math.max(a0, b0);
    }

    // Dos rectángulos "chocan" si se traslapan en AMBOS ejes por más de
    // HOLGURA_ENCIMADO px. Cada rectángulo se infla MARGEN_MINIMO px por
    // lado antes de comparar (ver _siguienteSlot).
    _seSolapan(a, b) {
        return (
            this._solapeEje(
                a.x - MARGEN_MINIMO, a.x + a.w + MARGEN_MINIMO,
                b.x - MARGEN_MINIMO, b.x + b.w + MARGEN_MINIMO
            ) > HOLGURA_ENCIMADO &&
            this._solapeEje(
                a.y - MARGEN_MINIMO, a.y + a.h + MARGEN_MINIMO,
                b.y - MARGEN_MINIMO, b.y + b.h + MARGEN_MINIMO
            ) > HOLGURA_ENCIMADO
        );
    }

    _limitar(x, y) {
        const maxX = Math.max(0, this.anchoLienzo - ANCHO_TARJETA);
        const maxY = Math.max(0, this.altoLienzo - ALTO_TARJETA);
        return [Math.max(0, Math.min(x, maxX)), Math.max(0, Math.min(y, maxY))];
    }

    // Hueco libre para una card NUEVA (nunca antes posicionada): recorre una
    // rejilla virtual de ANCHO_TARJETA+SEPARACION y devuelve la primera
    // celda que no choque con ninguna card ya colocada. Solo se usa al
    // agregar por primera vez (agregarAMesa) - nunca reposiciona una card
    // que ya tiene posición guardada.
    _siguienteSlot() {
        const colocadas = this.state.mesa
            .filter((id) => this.state.posiciones[id])
            .map((id) => this._headerRect(id));
        const dims = { w: ANCHO_TARJETA, h: ALTO_TARJETA };
        const cols = Math.max(1, Math.floor(ANCHO_LIENZO / (ANCHO_TARJETA + SEPARACION)));
        for (let fila = 0; fila < 60; fila++) {
            for (let col = 0; col < cols; col++) {
                const x = col * (ANCHO_TARJETA + SEPARACION);
                const y = fila * (ALTO_TARJETA + SEPARACION);
                const rect = this._rect({ x, y }, dims);
                if (!colocadas.some((r) => this._seSolapan(rect, r))) {
                    return { x, y };
                }
            }
        }
        return { x: 0, y: 0 };
    }

    // ---- rectángulo de la tarjeta compacta ------------------------------

    // Rectángulo de la card en el lienzo: SIEMPRE del tamaño de la tarjeta
    // compacta, esté abierta o no (su panel va al dock). Lo usa _siguienteSlot.
    _headerRect(examenId) {
        return this._rect(this._pos(examenId), { w: ANCHO_TARJETA, h: ALTO_TARJETA });
    }

    // Prioridad de una card para el orden de encimado (z-index de su
    // cabecera, ver estiloCabecera): el contador de _traerAlFrente si alguna
    // vez se abrió o arrastró, o si nunca se tocó, -examenId como desempate
    // ESTABLE y siempre único, que queda por debajo de cualquier prioridad
    // asignada por _traerAlFrente (arranca en 11, siempre positiva).
    _prioridad(examenId) {
        return this.state.zIndices[examenId] !== undefined
            ? this.state.zIndices[examenId]
            : -examenId;
    }

    // Contador monótono de "traída al frente": pintar por encima de las
    // demás cards. Nunca baja, así que "la última tocada" queda siempre
    // arriba de lo que ya estaba.
    _traerAlFrente(examenId) {
        this._zSiguiente += 1;
        this.state.zIndices[examenId] = this._zSiguiente;
    }

    // ---- zoom manual -------------------------------------------------

    zoomIn() {
        this.state.zoom = Math.min(ZOOM_MAX, Math.round((this.state.zoom + ZOOM_PASO) * 10) / 10);
    }

    zoomOut() {
        this.state.zoom = Math.max(ZOOM_MIN, Math.round((this.state.zoom - ZOOM_PASO) * 10) / 10);
    }

    // ---- arrastre libre con Pointer Events (mouse + táctil) -------------
    //
    // Se dispara SOLO desde la manija (⠿): el resto de la tarjeta (click de
    // Expandir/Quitar/alternar) usa sus propios manejadores y nunca ve estos
    // eventos. touch-action:none en la manija evita que el navegador
    // interprete el gesto como scroll de la página en vez de drag.

    alPresionarManija(ev, examenId) {
        const lienzo = this.lienzoRef.el;
        if (!lienzo) {
            return;
        }
        ev.preventDefault();
        // setPointerCapture: los pointermove/pointerup que siguen se siguen
        // recibiendo aunque el dedo/cursor salga de la manija (no hacen
        // falta listeners en window).
        ev.target.setPointerCapture(ev.pointerId);
        const rect = lienzo.getBoundingClientRect();
        const p = this._pos(examenId);
        // clientX/clientY están en espacio de PANTALLA; el lienzo tiene
        // transform:scale(zoom), así que hay que dividir por el zoom para
        // volver a coordenadas del canvas - si no, arrastrar con zoom
        // distinto de 100% desfasaría la tarjeta del cursor.
        const canvasX = (ev.clientX - rect.left) / this.state.zoom;
        const canvasY = (ev.clientY - rect.top) / this.state.zoom;
        this._arrastre = {
            pointerId: ev.pointerId,
            examenId,
            desfaseX: canvasX - p.x,
            desfaseY: canvasY - p.y,
            movido: false,
        };
        this._traerAlFrente(examenId);
    }

    alMoverManija(ev) {
        const a = this._arrastre;
        if (!a || ev.pointerId !== a.pointerId) {
            return;
        }
        ev.preventDefault();
        const lienzo = this.lienzoRef.el;
        if (!lienzo) {
            return;
        }
        const rect = lienzo.getBoundingClientRect();
        const canvasX = (ev.clientX - rect.left) / this.state.zoom;
        const canvasY = (ev.clientY - rect.top) / this.state.zoom;
        const [x, y] = this._limitar(canvasX - a.desfaseX, canvasY - a.desfaseY);
        a.movido = true;
        this.state.posiciones[a.examenId] = { x, y };
    }

    async alSoltarManija(ev) {
        const a = this._arrastre;
        if (!a || ev.pointerId !== a.pointerId) {
            return;
        }
        if (ev.target.hasPointerCapture(ev.pointerId)) {
            ev.target.releasePointerCapture(ev.pointerId);
        }
        this._arrastre = null;
        if (!a.movido) {
            return;
        }
        const p = this.state.posiciones[a.examenId];
        // (0,0) es el centinela de "sin posición": si la tarjeta acabó justo
        // ahí, la empujamos 1px para que sí se persista.
        const x = p.x === 0 && p.y === 0 ? 1 : p.x;
        await this.orm.write("taekwondo.examen", [a.examenId], {
            posicion_x: x,
            posicion_y: p.y,
        });
    }

    // ---- callbacks del panel -----------------------------------------

    async onCriterioGuardado(examenId) {
        // Solo repreguntamos por ESTE examen (4 filas), no por todo el
        // evento de nuevo: mismo espíritu de "batch, no uno por uno" pero
        // aplicado a la actualización puntual que sí necesitamos aquí.
        const criterios = await this.orm.searchRead(
            "taekwondo.criterio_calificacion",
            [["examen_id", "=", examenId]],
            ["calificacion"]
        );
        this.state.progreso[examenId] = criterios.filter((c) => c.calificacion).length;
    }

    onResultadoCambiado(examenId, valor) {
        // A diferencia de onCriterioGuardado, aquí NO volvemos a preguntarle
        // al servidor: el Panel ya sabe con certeza qué valor acaba de
        // escribir (él mismo lo mandó), así que nos lo pasa directo y solo
        // actualizamos el estado local. rosterPorExamenId[examenId] es la
        // MISMA referencia de objeto que vive dentro de state.roster (el
        // getter solo la busca, no la copia), así que mutarla aquí sí
        // dispara el re-render de quien esté leyendo ese dato.
        const item = this.rosterPorExamenId[examenId];
        if (item) {
            item.resultado = valor;
        }
    }

    onMejorExamenCambiado(examenId, valor) {
        // Mismo mecanismo que onResultadoCambiado: el Panel ya sabe el
        // valor exacto, así que solo actualizamos la referencia local.
        const item = this.rosterPorExamenId[examenId];
        if (item) {
            item.mejorExamen = valor;
        }
    }
}

registry.category("actions").add("mi_primer_modulo.tablero_calificacion", TableroCalificacion);
