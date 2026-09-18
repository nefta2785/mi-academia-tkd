import { Component, onWillStart, onWillUnmount, useEffect, useRef, useState } from "@odoo/owl";
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
const ANCHO_TARJETA = 360;
// Alto de una tarjeta colapsada (header + fila de botones). Es el único alto
// fijo que existe: una tarjeta ABIERTA ocupa el mismo espacio en el canvas
// que una colapsada - su body es position:absolute y NUNCA cuenta para el
// tamaño ni la posición de la card (ver estiloCuerpoAbierto).
const ALTO_TARJETA = 140;
const ANCHO_LIENZO = 1400;
const ANCHO_LIENZO_MAX = 4000;
const ALTO_LIENZO_MAX = 3000;
const SEPARACION = 16;
const HOLGURA_ENCIMADO = 40;       // px de traslape tolerado antes de considerar "encimadas"
const MARGEN_MINIMO = 2;           // separación mínima al buscar hueco libre para una card nueva
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1;
const ZOOM_PASO = 0.1;
// Tiers de z-index (independientes de la prioridad de cada card, que se
// SUMA a cada uno - ver _prioridad): garantizan que un header siempre
// pinte por encima de CUALQUIER body, y que el tag de "traer al frente"
// siempre pinte por encima de CUALQUIER header, sin importar de qué card
// sea cada uno.
const Z_HEADER_BASE = 500;
const Z_TAG_BASE = 1500;
// Tamaño fijo del tag que sobresale al costado de una card cubierta.
const ANCHO_TAG = 44;
const ALTO_TAG = 40;

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
            // 'tarjetasAbiertas': cuáles muestran el panel completo inline.
            // 'alturasCuerpo': {examenId: px} alto REAL renderizado del body
            // de cada card abierta (medido vía ResizeObserver, ya limitado
            // por su propio max-height:70vh) - se usa para saber a quién
            // cubre, ver _cuerpoRect.
            // 'zIndices': {examenId: numero} orden de "traída al frente";
            // más alto = más arriba visualmente y gana los empates de
            // cobertura cuando varias cards abiertas solapan a una misma.
            // 'expandido': tarjeta a pantalla completa, o null.
            // 'zoom': factor de escala manual del tablero completo (0.5-1).
            mesa: [],
            posiciones: {},
            tarjetasAbiertas: [],
            alturasCuerpo: {},
            zIndices: {},
            expandido: null,
            zoom: ZOOM_MAX,
            progreso: {},
        });

        // Arrastre libre en curso. No es estado reactivo: solo vive entre
        // pointerdown y pointerup/pointercancel de un mismo gesto.
        this._arrastre = null;
        // Arrastre del TAG de una card cubierta (independiente del de la
        // manija): permite reposicionarla sin traerla al frente. Solo se
        // trae al frente si el gesto termina SIN moverse (click simple),
        // ver alSoltarTag.
        this._arrastreTag = null;
        // Contador monótono para "traer al frente" (abrir una card o tocar
        // su tag le asigna el siguiente número; nunca baja).
        this._zSiguiente = 10;
        // ResizeObserver activo por cada card abierta, para medir su body
        // real (ver el useEffect de abajo). Map, no state: no necesita ser
        // reactivo, solo vive mientras el componente está montado.
        this._observadores = new Map();

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

        // Mide el body REAL de cada card abierta (ya limitado por su propio
        // max-height:70vh) para saber a quién cubre - ver _cuerpoRect. Se
        // reengancha cada vez que cambia el conjunto de cards abiertas;
        // dentro de eso, ResizeObserver reacciona a cambios de alto por
        // contenido (ej. escribir un comentario largo) sin depender de
        // otro render.
        useEffect(
            () => {
                for (const examenId of this.state.tarjetasAbiertas) {
                    if (this._observadores.has(examenId)) {
                        continue;
                    }
                    const el = this.lienzoRef.el
                        && this.lienzoRef.el.querySelector(`[data-cuerpo-id="${examenId}"]`);
                    if (!el) {
                        continue;
                    }
                    const observador = new ResizeObserver(() => {
                        this.state.alturasCuerpo[examenId] = el.clientHeight;
                    });
                    observador.observe(el);
                    this._observadores.set(examenId, observador);
                    this.state.alturasCuerpo[examenId] = el.clientHeight;
                }
                for (const [examenId, observador] of this._observadores) {
                    if (!this.state.tarjetasAbiertas.includes(examenId)) {
                        observador.disconnect();
                        this._observadores.delete(examenId);
                        delete this.state.alturasCuerpo[examenId];
                    }
                }
            },
            () => [this.state.tarjetasAbiertas.join(",")]
        );

        onWillUnmount(() => {
            for (const observador of this._observadores.values()) {
                observador.disconnect();
            }
            this._observadores.clear();
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
        // Alto real de cada card SIEMPRE es ALTO_TARJETA (el body abierto es
        // position:absolute y no cuenta aquí, ver estiloCuerpoAbierto): el
        // lienzo crece solo según hasta dónde se arrastró alguna card.
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

    // Posición libre de cada card: x/y propios, ancho SIEMPRE fijo (abierta
    // o colapsada, Paso 1). SIN z-index propio a propósito: si el wrapper
    // tuviera un z-index numérico, se volvería un stacking context nuevo y
    // atraparía dentro suyo al cardBox/tag, impidiéndoles competir en
    // tiers globales (Z_HEADER_BASE/Z_TAG_BASE) contra los de las demás
    // cards - ver estiloCardBox/estiloCabecera/estiloTag/estiloCuerpoAbierto.
    estiloTarjeta(examenId) {
        const p = this._pos(examenId);
        return `position: absolute; left: ${p.x}px; top: ${p.y}px; width: ${ANCHO_TARJETA}px;`;
    }

    // Contenedor externo completo (el que lleva el borde de color
    // aprobado/reprobado/pendiente): oculto TOTAL (Paso 1) cuando esta card
    // está cubierta - a diferencia de antes, esto es lo único que decide la
    // visibilidad; cabecera y body NO repiten la condición (ver
    // estiloCabecera/estiloCuerpoAbierto) porque ocultar este contenedor ya
    // oculta TODO lo que hay dentro, borde incluido.
    //
    // visibility:hidden y NO display:none a propósito: el cuerpo abierto
    // (con data-cuerpo-id, medido por el ResizeObserver de setup()) vive
    // DENTRO de este contenedor. display:none lo habría colapsado a
    // clientHeight 0 en cuanto la card se cubre, y _cuerpoRect habría
    // tratado ese 0 como "altura sin medir" (ver su chequeo) - encogiendo el
    // footprint de vuelta a solo el header, lo que le hacía dejar de
    // solaparse con la cubridora, revelándose de nuevo, remidiendo su alto
    // real, volviendo a solaparse... parpadeo infinito por retroalimentación
    // entre cobertura y medición. visibility:hidden esconde exactamente
    // igual (nada del contenido ni el borde queda visible) pero conserva el
    // tamaño en el layout, así el observer siempre mide la altura real.
    estiloCardBox(examenId) {
        return this.esCubierta(examenId) ? "position: relative; visibility: hidden;" : "position: relative;";
    }

    // Cabecera (header + fila de botones Expandir/Quitar): tier de z-index
    // propio, siempre por encima de CUALQUIER body sin importar de quién
    // (Z_HEADER_BASE + prioridad). position:relative para que el z-index
    // numérico aplique. Su visibilidad ya la decide estiloCardBox (el
    // padre) - no repite la condición de cubierta.
    estiloCabecera(examenId) {
        const prioridad = this._prioridad(examenId);
        return `position: relative; z-index: ${Z_HEADER_BASE + prioridad};`;
    }

    // Tag de "traer al frente" (Paso 2): ANCLADO a las coordenadas reales
    // de ESTA MISMA card (no a la de quien la cubre), a la altura de su
    // propio header (oculto). HERMANO del cardBox que se oculta (nunca su
    // hijo) - así se sigue renderizando aunque el resto de la card esté
    // 100% display:none. Posición elegida por _posicionTag, que evita
    // colisionar con CUALQUIER card visible o tag ya colocado (no solo
    // contra el límite del lienzo). Tier de z-index propio por encima de
    // TODOS los headers (Z_TAG_BASE), así nunca queda enterrado por un
    // body que lo solape lateralmente.
    estiloTag(examenId) {
        const prioridad = this._prioridad(examenId);
        const p = this._pos(examenId);
        const pos = this._posicionTag(examenId);
        return `position: absolute; left: ${pos.x - p.x}px; top: ${pos.y - p.y}px; ` +
            `width: ${ANCHO_TAG}px; height: ${ALTO_TAG}px; z-index: ${Z_TAG_BASE + prioridad}; ` +
            `cursor: grab; touch-action: none;`;
    }

    // Body de la card abierta: se extiende hacia ABAJO por fuera del alto
    // fijo de su propia card (position:absolute), sin afectar su tamaño ni
    // posición en el lienzo. Scroll interno intacto. Su z-index es la
    // prioridad "cruda" (sin tier): siempre por debajo de CUALQUIER
    // cabecera (mínimo Z_HEADER_BASE), y entre bodies se ordenan por
    // recencia igual que antes. Su visibilidad ya la decide estiloCardBox
    // (el padre) - no repite la condición de cubierta.
    estiloCuerpoAbierto(examenId) {
        const prioridad = this._prioridad(examenId);
        return `position: absolute; top: 100%; left: 0; width: ${ANCHO_TARJETA}px; ` +
            `max-height: 70vh; overflow-y: auto; z-index: ${prioridad};`;
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

    // ---- cobertura por solape real (no por columna) ---------------------

    // Rectángulo de la card tal como se ve colapsada/normal (header + fila
    // de botones): SIEMPRE del mismo tamaño, esté abierta o no.
    _headerRect(examenId) {
        return this._rect(this._pos(examenId), { w: ANCHO_TARJETA, h: ALTO_TARJETA });
    }

    // Rectángulo real del body de una card ABIERTA (null si aún no se ha
    // medido su alto real - ver el useEffect de setup(), o si no está
    // abierta). Empieza justo debajo de su propia card (y + ALTO_TARJETA).
    _cuerpoRect(examenId) {
        const alto = this.state.alturasCuerpo[examenId];
        // === undefined (nunca medido), no !alto: un alto de 0 medido de
        // verdad debe contar como "sin cuerpo", no confundirse con "no
        // medido todavía" - ver el comentario de estiloCardBox sobre por
        // qué ya no debería poder llegar un 0 espurio aquí, pero más vale
        // no depender de que 0 sea falsy para la corrección de este cálculo.
        if (alto === undefined) {
            return null;
        }
        const p = this._pos(examenId);
        return { x: p.x, y: p.y + ALTO_TARJETA, w: ANCHO_TARJETA, h: alto };
    }

    // Los 1-2 rectángulos que ocupa REALMENTE esta card en el lienzo: su
    // header siempre, y también su body si está abierta y ya se midió su
    // alto real (ver _cuerpoRect). El "footprint" completo es la unión de
    // ambos, no solo el header - así una card abierta cuenta también su
    // body al decidir si cubre o es cubierta.
    _footprint(examenId) {
        const rects = [this._headerRect(examenId)];
        const cuerpo = this._cuerpoRect(examenId);
        if (cuerpo) {
            rects.push(cuerpo);
        }
        return rects;
    }

    // Prioridad real de una card para decidir "quién gana" (queda visible)
    // en un solape: el contador de _traerAlFrente si alguna vez se tocó
    // (abrir, arrastrar, click en su tag), o si nunca se tocó, -examenId
    // como desempate ESTABLE y siempre único. -examenId garantiza dos
    // cosas: (1) nunca coincide entre dos cards distintas (los examenId
    // son únicos), así que dos cards NUNCA tocadas que se solapen siguen
    // teniendo un ganador determinista - nunca ambas visibles a la vez
    // (Paso 1); y (2) siempre queda por debajo de cualquier prioridad real
    // asignada por _traerAlFrente (arranca en 11, siempre positiva), así
    // que una card nunca tocada jamás le "gana" a una que sí fue traída al
    // frente.
    _prioridad(examenId) {
        return this.state.zIndices[examenId] !== undefined
            ? this.state.zIndices[examenId]
            : -examenId;
    }

    // Una card está "cubierta" (oculta por completo, Paso 1) si el
    // footprint completo de ALGUNA otra con mayor prioridad solapa el
    // suyo - sin importar si esa otra está abierta o cerrada: dos headers
    // cerrados casi en el mismo punto también cuentan (evita el caso de un
    // header reducido a un borde de 1px, inútil para hacer clic). No hace
    // falta excluir aparte a "la card al frente": por definición nadie
    // tiene prioridad mayor que ella, así que nunca se oculta a sí misma.
    esCubierta(examenId) {
        const prioridadPropia = this._prioridad(examenId);
        const propio = this._footprint(examenId);
        for (const id of this.state.mesa) {
            if (id === examenId) {
                continue;
            }
            if (this._prioridad(id) <= prioridadPropia) {
                continue;
            }
            const otro = this._footprint(id);
            if (propio.some((r1) => otro.some((r2) => this._seSolapan(r1, r2)))) {
                return true;
            }
        }
        return false;
    }

    // Rectángulo real del tag YA COLOCADO de una card cubierta (recursivo
    // vía _posicionTag) - se usa como obstáculo para las cards que se
    // colocan DESPUÉS que ella en 'mesa' (ver _obstaculosTag). Nunca hay
    // ciclos: cada _posicionTag solo mira obstáculos de ids que vienen
    // ANTES que él en 'mesa'.
    _rectTag(examenId) {
        const pos = this._posicionTag(examenId);
        return { x: pos.x, y: pos.y, w: ANCHO_TAG, h: ALTO_TAG };
    }

    // Todo lo que el tag de esta card debe evitar (Paso 2): el footprint
    // de CUALQUIER OTRA card actualmente VISIBLE (abierta o cerrada, no
    // solo "abiertas" en sentido estricto - una card cerrada visible
    // también ocupa espacio real en el lienzo), y el tag YA COLOCADO de
    // cualquier otra card cubierta que venga ANTES en 'mesa' en este
    // mismo render. Antes esto solo se comparaba contra el límite del
    // lienzo (_ladoTag) o contra una única card en la misma posición
    // exacta (_indiceApilado) - nunca contra el conjunto real de lo que
    // hay dibujado, que es justo lo que dejaba el tag "flotando" sobre
    // alguna de las cubridoras.
    _obstaculosTag(examenId) {
        const rects = [];
        const indiceExamen = this.state.mesa.indexOf(examenId);
        for (const id of this.state.mesa) {
            if (id === examenId) {
                continue;
            }
            if (!this.esCubierta(id)) {
                rects.push(...this._footprint(id));
            } else if (this.state.mesa.indexOf(id) < indiceExamen) {
                rects.push(this._rectTag(id));
            }
        }
        return rects;
    }

    // Desde 'base', prueba hasta 'intentosMax' posiciones desplazándose
    // (dx,dy) por cada intento, y devuelve la primera que no choque con
    // ningún obstáculo - o null si ninguna cupo en esos intentos.
    _intentarSlot(base, dx, dy, obstaculos, intentosMax) {
        for (let i = 0; i < intentosMax; i++) {
            const candidato = { x: base.x + dx * i, y: base.y + dy * i, w: base.w, h: base.h };
            if (!obstaculos.some((o) => this._seSolapan(candidato, o))) {
                return candidato;
            }
        }
        return null;
    }

    // Posición real (canvas, no relativa al wrapper) del tag de esta
    // card (Paso 2): prueba derecha, luego izquierda, luego debajo de su
    // propia card - en cada lado, si el primer punto choca con algún
    // obstáculo (_obstaculosTag), se apila (hacia abajo en los costados,
    // hacia el lado en "debajo") hasta encontrar hueco libre. Si un lado
    // no cabe dentro del lienzo se salta directo al siguiente.
    _posicionTag(examenId) {
        const p = this._pos(examenId);
        const obstaculos = this._obstaculosTag(examenId);
        const alturaHeader = p.y + (ALTO_TARJETA - ALTO_TAG) / 2;

        if (p.x + ANCHO_TARJETA + ANCHO_TAG <= this.anchoLienzo) {
            const base = { x: p.x + ANCHO_TARJETA + 4, y: alturaHeader, w: ANCHO_TAG, h: ALTO_TAG };
            const slot = this._intentarSlot(base, 0, ALTO_TAG + 4, obstaculos, 12);
            if (slot) {
                return slot;
            }
        }
        if (p.x - ANCHO_TAG - 4 >= 0) {
            const base = { x: p.x - ANCHO_TAG - 4, y: alturaHeader, w: ANCHO_TAG, h: ALTO_TAG };
            const slot = this._intentarSlot(base, 0, ALTO_TAG + 4, obstaculos, 12);
            if (slot) {
                return slot;
            }
        }
        const base = { x: p.x, y: p.y + ALTO_TARJETA + 4, w: ANCHO_TAG, h: ALTO_TAG };
        return this._intentarSlot(base, ANCHO_TAG + 4, 0, obstaculos, 12) || base;
    }

    // Contador monótono de "traída al frente": ganar en cobertura y pintar
    // por encima de las demás. Nunca baja, así que "la última tocada" queda
    // siempre arriba de lo que ya estaba.
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

    // ---- tag de una card cubierta (Paso 2) ------------------------------
    //
    // Mismo patrón de Pointer Events que la manija, pero con una diferencia
    // clave: NO trae al frente en el pointerdown (a diferencia de la
    // manija). Eso permite distinguir, al soltar, un click simple (sin
    // moverse: trae al frente y abre) de un arrastre real (mueve la card
    // SIN revelarla - sigue cubierta si corresponde, ver Paso 2 punto 4).

    alPresionarTag(ev, examenId) {
        const lienzo = this.lienzoRef.el;
        if (!lienzo) {
            return;
        }
        ev.preventDefault();
        ev.target.setPointerCapture(ev.pointerId);
        const rect = lienzo.getBoundingClientRect();
        const p = this._pos(examenId);
        const canvasX = (ev.clientX - rect.left) / this.state.zoom;
        const canvasY = (ev.clientY - rect.top) / this.state.zoom;
        this._arrastreTag = {
            pointerId: ev.pointerId,
            examenId,
            desfaseX: canvasX - p.x,
            desfaseY: canvasY - p.y,
            movido: false,
        };
    }

    alMoverTag(ev) {
        const a = this._arrastreTag;
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

    async alSoltarTag(ev) {
        const a = this._arrastreTag;
        if (!a || ev.pointerId !== a.pointerId) {
            return;
        }
        if (ev.target.hasPointerCapture(ev.pointerId)) {
            ev.target.releasePointerCapture(ev.pointerId);
        }
        this._arrastreTag = null;
        if (!a.movido) {
            // Click simple (sin arrastre): trae al frente y abre - mismo
            // mecanismo que abrir cualquier card, sin cambiar su x/y.
            if (!this.state.tarjetasAbiertas.includes(a.examenId)) {
                this.state.tarjetasAbiertas.push(a.examenId);
            }
            this._traerAlFrente(a.examenId);
            return;
        }
        // Arrastre real: igual que alSoltarManija - persiste la nueva
        // posición y NO trae al frente (el tag se movió junto con su
        // card, que sigue cubierta si corresponde).
        const p = this.state.posiciones[a.examenId];
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
