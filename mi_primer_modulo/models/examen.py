from odoo import api, fields, models
from odoo.exceptions import UserError


class TaekwondoExamen(models.Model):
    _name = 'taekwondo.examen'
    _description = 'Examen de cinta'
    _rec_name = 'folio'

    folio = fields.Char(string='Folio', readonly=True, copy=False, default=lambda self: 'Nuevo')
    evento_id = fields.Many2one(
        comodel_name='taekwondo.evento_examen',
        string='Evento de examen',
        ondelete='restrict',
    )
    alumno_id = fields.Many2one(
        comodel_name='taekwondo.alumno',
        string='Alumno',
        required=True,
        ondelete='cascade',
    )
    fecha_examen = fields.Date(
        string='Fecha del examen',
        required=True,
        default=fields.Date.context_today,
    )
    cinta_evaluada = fields.Selection(
        selection=[
            ('blanca', 'Blanca'),
            ('amarilla', 'Amarilla'),
            ('amarilla_avanzada', 'Amarilla avanzada'),
            ('naranja', 'Naranja'),
            ('naranja_avanzada', 'Naranja avanzada'),
            ('verde', 'Verde'),
            ('verde_avanzada', 'Verde avanzada'),
            ('azul', 'Azul'),
            ('azul_avanzada', 'Azul avanzada'),
            ('roja', 'Roja'),
            ('roja_avanzada', 'Roja avanzada'),
            ('negra', 'Negra'),
        ],
        string='Cinta evaluada',
    )
    sinodal = fields.Char(string='Sinodal')
    resultado = fields.Selection(
        selection=[
            ('aprobado', 'Aprobado'),
            ('reprobado', 'Reprobado'),
            ('pendiente', 'Pendiente'),
        ],
        string='Resultado',
        default='pendiente',
    )
    notas_sinodal = fields.Text(string='Notas del sinodal')
    mejor_examen = fields.Boolean(string='Mejor Examen', default=False)
    costo_examen = fields.Float(string='Costo del examen')
    costo_sinodal = fields.Float(string='Pago a sinodal', default=0.0)
    costo_institucion = fields.Float(string='Pago a institución', default=0.0)
    costo_tabla = fields.Float(string='Costo de tabla', default=0.0)
    costo_cinta = fields.Float(string='Costo de cinta', default=0.0)
    ganancia_examen = fields.Float(
        string='Ganancia neta del examen',
        compute='_compute_ganancia_examen',
        store=True,
        readonly=True,
    )
    criterios_ids = fields.One2many(
        comodel_name='taekwondo.criterio_calificacion',
        inverse_name='examen_id',
        string='Criterios de calificación',
    )
    aditamentos_ids = fields.One2many(
        comodel_name='taekwondo.examen_aditamento',
        inverse_name='examen_id',
        string='Aditamentos',
    )
    factura_id = fields.Many2one(
        comodel_name='account.move',
        string='Factura generada',
        readonly=True,
        copy=False,
    )

    _CATEGORIAS_CRITERIO = ['basicos', 'poomse', 'kiorugui', 'kiopka']

    @api.depends(
        'costo_examen', 'costo_sinodal', 'costo_institucion', 'costo_tabla', 'costo_cinta',
        'aditamentos_ids.costo',
    )
    def _compute_ganancia_examen(self):
        for examen in self:
            examen.ganancia_examen = examen.costo_examen - (
                examen.costo_sinodal
                + examen.costo_institucion
                + examen.costo_tabla
                + examen.costo_cinta
                + sum(examen.aditamentos_ids.mapped('costo'))
            )

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('folio', 'Nuevo') == 'Nuevo':
                vals['folio'] = self.env['ir.sequence'].next_by_code('taekwondo.examen')

        examenes = super().create(vals_list)

        for examen in examenes:
            self.env['taekwondo.criterio_calificacion'].create([
                {'examen_id': examen.id, 'categoria': categoria}
                for categoria in self._CATEGORIAS_CRITERIO
            ])

        return examenes

    def action_generar_factura_examen(self):
        self.ensure_one()

        if self.costo_examen <= 0:
            raise UserError(
                "Este examen no tiene capturado un Costo del examen (o está en 0). "
                "Captura el costo del examen antes de generar la factura."
            )

        if self.factura_id:
            if self.factura_id.state == 'draft':
                linea_producto = self.factura_id.invoice_line_ids.filtered(
                    lambda linea: linea.display_type == 'product'
                )
                linea_producto.price_unit = self.costo_examen
            return {
                'type': 'ir.actions.act_window',
                'res_model': 'account.move',
                'res_id': self.factura_id.id,
                'view_mode': 'form',
            }

        if not self.alumno_id.partner_id:
            raise UserError(
                "El alumno %s no tiene un Contacto de facturación configurado. "
                "Asígnale uno desde su ficha antes de generar la factura." % self.alumno_id.name
            )

        producto = self.env['product.product'].search(
            [('default_code', '=', 'EXAM-TKD')], limit=1,
        )
        if not producto:
            raise UserError(
                "No se encontró el producto con Referencia interna 'EXAM-TKD' (Examen de Cinta). "
                "Créalo primero desde Ventas o Facturación para poder generar esta factura."
            )

        factura = self.env['account.move'].create({
            'move_type': 'out_invoice',
            'partner_id': self.alumno_id.partner_id.id,
            'invoice_date': self.fecha_examen,
            'invoice_line_ids': [(0, 0, {
                'product_id': producto.id,
                'quantity': 1,
                'price_unit': self.costo_examen,
            })],
        })
        self.factura_id = factura.id

        return {
            'type': 'ir.actions.act_window',
            'res_model': 'account.move',
            'res_id': factura.id,
            'view_mode': 'form',
        }
