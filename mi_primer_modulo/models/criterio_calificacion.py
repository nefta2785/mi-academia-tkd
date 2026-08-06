from odoo import fields, models


class TaekwondoCriterioCalificacion(models.Model):
    _name = 'taekwondo.criterio_calificacion'
    _description = 'Criterio de calificación de examen'

    examen_id = fields.Many2one(
        comodel_name='taekwondo.examen',
        string='Examen',
        required=True,
        ondelete='cascade',
    )
    categoria = fields.Selection(
        selection=[
            ('basicos', 'Básicos'),
            ('poomse', 'Poomse'),
            ('kiorugui', 'Kiorugui'),
            ('kiopka', 'Kiopka'),
        ],
        string='Categoría',
        required=True,
    )
    calificacion = fields.Selection(
        selection=[
            ('E', 'Excelente'),
            ('MB', 'Muy Bueno'),
            ('B', 'Bueno'),
            ('R', 'Regular'),
        ],
        string='Calificación',
    )
    comentario = fields.Text(string='Comentario del sinodal')
